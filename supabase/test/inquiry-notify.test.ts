/**
 * Runs the website's Supabase migrations on a real Postgres (PGlite) with a
 * stand-in for Supabase's auth schema and roles, and checks what the
 * notify-inquiry function depends on: visitors can save their own answers but
 * not the notified_at stamp, only the service role can claim an email, and a
 * claim is granted once per change and at most every 10 minutes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { buildMessage } from "../functions/notify-inquiry/message.js";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const UID = "11111111-1111-1111-1111-111111111111";

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`;

let db: PGlite;

async function asVisitor<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec(`set request.jwt.claim.sub = '${UID}'; set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role;");
  }
}

// What supabase-js's upsert() turns into through PostgREST.
const UPSERT = `
  insert into public.profiles (id, email, company, spend, notes, updated_at)
  values ($1, 'ana@northwind.test', $2, '$1k – $10k / month', $3, now())
  on conflict (id) do update set id = excluded.id, email = excluded.email, company = excluded.company,
    spend = excluded.spend, notes = excluded.notes, updated_at = excluded.updated_at`;

async function claim() {
  await db.exec("set role service_role;");
  try {
    const r = await db.query<{ company: string; previous_notified_at: Date | null }>(
      "select * from public.claim_inquiry_notification($1)",
      [UID],
    );
    return r.rows;
  } finally {
    await db.exec("reset role;");
  }
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const f of readdirSync(MIGRATIONS).sort()) await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  await db.exec(`grant all on public.profiles to service_role; insert into auth.users values ('${UID}');`);
});

describe("website inquiry migrations", () => {
  it("lets a visitor save and change their own answers", async () => {
    await asVisitor(() => db.query(UPSERT, [UID, "Northwind", null]));
    await asVisitor(() => db.query(UPSERT, [UID, "Northwind Dental", "Quote for View and control"]));
    const r = await db.query<{ company: string }>("select company from public.profiles");
    expect(r.rows).toEqual([{ company: "Northwind Dental" }]);
  });

  it("does not let a visitor set notified_at or claim an email", async () => {
    await asVisitor(() => db.query(UPSERT, [UID, "Northwind", null]));
    await expect(asVisitor(() => db.query("update public.profiles set notified_at = now()"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asVisitor(() => db.query("select * from public.claim_inquiry_notification($1)", [UID])),
    ).rejects.toThrow(/permission denied/);
  });

  it("grants one claim per change, and none within 10 minutes of the last email", async () => {
    await asVisitor(() => db.query(UPSERT, [UID, "Northwind", null]));
    const first = await claim();
    expect(first).toHaveLength(1);
    expect(first[0]!.previous_notified_at).toBeNull();
    expect(await claim()).toHaveLength(0); // nothing changed

    await asVisitor(() => db.query(UPSERT, [UID, "Northwind Dental", null]));
    expect(await claim()).toHaveLength(0); // changed, but the last email was just now

    await db.exec("update public.profiles set notified_at = now() - interval '11 minutes'");
    await asVisitor(() => db.query(UPSERT, [UID, "Northwind Dental", "Quote please"]));
    const later = await claim();
    expect(later).toHaveLength(1);
    expect(later[0]!.previous_notified_at).not.toBeNull();
  });

  it("returns nothing for someone who has not saved answers", async () => {
    expect(await claim()).toHaveLength(0);
  });
});

describe("inquiry email", () => {
  const base = { spend: "$1k – $10k / month", created_at: "2026-11-14T10:00:00Z", previous_notified_at: null };

  it("marks quote requests and keeps the subject on one line", () => {
    const m = buildMessage({ ...base, company: "Northwind\r\nBcc: x@evil.test", notes: "We'd like a quote" }, "ana@northwind.test");
    expect(m.subject).toBe("New website inquiry (quote): Northwind Bcc: x@evil.test");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain("ana@northwind.test answered");
    expect(m.text).toContain("We'd like a quote");
  });

  it("says when answers were updated, and when notes are blank", () => {
    const m = buildMessage({ ...base, company: "Northwind", notes: null, previous_notified_at: "2026-11-14T09:00:00Z" }, "a@b.test");
    expect(m.subject).toBe("Updated website inquiry: Northwind");
    expect(m.text).toContain("(left blank)");
  });
});
