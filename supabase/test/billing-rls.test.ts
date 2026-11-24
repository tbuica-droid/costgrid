/**
 * The billing migration on a stand-in for Supabase: a visitor can read their
 * own plan and cannot write it, and cannot see the webhook idempotency table.
 * The inquiry migration still applies; this file runs every migration, including
 * that one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const ANA = "11111111-1111-1111-1111-111111111111";
const BEN = "22222222-2222-2222-2222-222222222222";

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

async function asRole<T>(role: string, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set request.jwt.claim.sub = '${userId}'; set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role;");
  }
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  await db.exec(`insert into auth.users values ('${ANA}'), ('${BEN}');`);
});

describe("billing row security", () => {
  it("lets a visitor read their own plan and not someone else's", async () => {
    await asRole("service_role", ANA, () =>
      db.query(
        `insert into public.billing (user_id, stripe_customer_id, plan, plan_status)
         values ($1, 'cus_ana', 'pro', 'active'), ($2, 'cus_ben', 'team', 'active')`,
        [ANA, BEN],
      ),
    );
    const own = await asRole("authenticated", ANA, () =>
      db.query<{ plan: string }>("select plan from public.billing"),
    );
    expect(own.rows).toEqual([{ plan: "pro" }]);
  });

  it("does not let a visitor write a plan or a Stripe id", async () => {
    await expect(
      asRole("authenticated", ANA, () =>
        db.query(
          "insert into public.billing (user_id, plan) values ($1, 'team')",
          [ANA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await asRole("service_role", ANA, () =>
      db.query("insert into public.billing (user_id, plan) values ($1, 'free')", [ANA]),
    );
    await expect(
      asRole("authenticated", ANA, () => db.query("update public.billing set plan = 'team'")),
    ).rejects.toThrow(/permission denied/);
  });

  it("does not let a visitor read or insert processed Stripe events", async () => {
    await asRole("service_role", ANA, () =>
      db.query("insert into public.stripe_events (id, type) values ('evt_1', 'invoice.paid')"),
    );
    await expect(asRole("authenticated", ANA, () => db.query("select * from public.stripe_events"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asRole("authenticated", ANA, () =>
        db.query("insert into public.stripe_events (id, type) values ('evt_2', 'invoice.paid')"),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("still lets a visitor save their own profile answers", async () => {
    await asRole("authenticated", ANA, () =>
      db.query(
        `insert into public.profiles (id, email, company, spend, notes, updated_at)
         values ($1, 'ana@northwind.test', 'Northwind', '$1k – $10k / month', null, now())`,
        [ANA],
      ),
    );
    const saved = await db.query<{ company: string }>("select company from public.profiles");
    expect(saved.rows).toEqual([{ company: "Northwind" }]);
  });
});
