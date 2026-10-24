import {
  AlertsRepository,
  CostGridRepository,
  ImportsRepository,
  openDatabase,
  SourcesRepository,
} from "@costgrid/db";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Alerter } from "../src/alerts.js";
import { AdminKeySync, reminderDue } from "../src/connect-sync.js";
import { adminKeyAccount, MemorySecretStore } from "../src/secret-store.js";

/**
 * The background job that keeps stored admin keys' imports current and
 * reminds the owner before a key expires. Time, the provider and the
 * keychain are all stand-ins.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const KEY = "sk-admin-SYNCTESTKEY-0123456789abcdef";
const TENANT = "tenant-1";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe("syncing stored admin keys", () => {
  let db: ReturnType<typeof openDatabase>;
  let imports: ImportsRepository;
  let sources: SourcesRepository;
  let alerts: AlertsRepository;
  let store: MemorySecretStore;
  let requests: { url: URL; key: string }[];
  let respond: () => Promise<Response>;
  let now: number;

  const usage = (): Response =>
    new Response(
      JSON.stringify({
        data: [
          {
            start_time: Math.floor((NOW - DAY) / 1000),
            results: [{ model: "gpt-5", project_id: "proj_a", input_tokens: 1000, output_tokens: 10, num_model_requests: 2 }],
          },
        ],
        has_more: false,
      }),
      { status: 200 },
    );

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, key: (init?.headers as Record<string, string>)["authorization"] ?? "" });
    // Name lookups are best effort; an empty list is fine.
    if (!url.pathname.includes("/usage/")) return new Response(JSON.stringify({ data: [], has_more: false }));
    return respond();
  }) as unknown as typeof fetch;

  function sync(): AdminKeySync {
    return new AdminKeySync({
      imports,
      sources,
      secretStore: store,
      alerter: new Alerter({ alerts, log: silent as unknown as FastifyBaseLogger }),
      log: silent,
      fetchImpl,
      now: () => now,
    });
  }

  async function keep(expiresAt: number | null): Promise<void> {
    await store.set(adminKeyAccount(TENANT, "openai"), KEY);
    sources.putAdminKey(TENANT, { provider: "openai", hint: "****cdef", expiresAt, createdAt: NOW - DAY });
  }

  const usageRequests = () => requests.filter((r) => r.url.pathname.includes("/usage/"));
  const meta = () => sources.adminKeys(TENANT)[0]!;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    new CostGridRepository(db).createTenant("Acme", TENANT);
    imports = new ImportsRepository(db);
    sources = new SourcesRepository(db);
    alerts = new AlertsRepository(db);
    store = new MemorySecretStore();
    requests = [];
    respond = async () => usage();
    now = NOW;
  });

  afterEach(() => db.close());

  it("imports with the stored key, 90 days the first time and since the last sync after", async () => {
    await keep(null);
    const job = sync();

    expect(await job.syncAll()).toEqual({ synced: 1, failed: 0, skipped: 0 });
    expect(usageRequests()[0]!.key).toBe(`Bearer ${KEY}`);
    expect(Number(usageRequests()[0]!.url.searchParams.get("start_time"))).toBe(Math.floor((NOW - 90 * DAY) / 1000));
    expect(meta()).toMatchObject({ lastSyncStatus: "ok", lastSyncError: null });
    expect(imports.recentRuns(TENANT)[0]).toMatchObject({ status: "ok", rowsWritten: 1, origin: "admin-api" });
    expect(sources.count(TENANT)).toBe(1);

    // Recorded at the real clock; the next window starts three days before it.
    const lastSyncAt = meta().lastSyncAt!;
    now = lastSyncAt + DAY;
    await job.syncAll();
    expect(Number(usageRequests()[1]!.url.searchParams.get("start_time"))).toBe(Math.floor((lastSyncAt - 3 * DAY) / 1000));
  });

  it("records a key the keychain no longer has", async () => {
    sources.putAdminKey(TENANT, { provider: "openai", hint: "****cdef", expiresAt: null, createdAt: NOW });
    expect(await sync().syncAll()).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(meta()).toMatchObject({ lastSyncStatus: "error", lastSyncError: "key missing from keychain" });
    expect(requests).toEqual([]);
  });

  it("records a provider error without the key in it, and goes back 90 days next time", async () => {
    await keep(null);
    respond = async () =>
      new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 });

    expect(await sync().syncAll()).toEqual({ synced: 0, failed: 1, skipped: 0 });
    expect(meta().lastSyncStatus).toBe("error");
    // The owner reads what to do; the run keeps the provider's words, without the key.
    expect(meta().lastSyncError).toMatch(/^OpenAI didn't accept this key for reading usage\./);
    expect(imports.recentRuns(TENANT)[0]!.errorMessage).toBe("provider returned 401: Incorrect API key provided: [key]");
    expect(JSON.stringify(imports.recentRuns(TENANT))).not.toContain(KEY);

    respond = async () => usage();
    await sync().syncAll();
    expect(Number(usageRequests()[1]!.url.searchParams.get("start_time"))).toBe(Math.floor((NOW - 90 * DAY) / 1000));
  });

  it("does not use a key past the expiry the owner chose", async () => {
    await keep(NOW - 1);
    expect(await sync().syncAll()).toEqual({ synced: 0, failed: 0, skipped: 1 });
    expect(requests).toEqual([]);
  });

  it("runs one sync at a time", async () => {
    await keep(null);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    respond = async () => {
      await gate;
      return usage();
    };

    const job = sync();
    const first = job.syncAll();
    const second = job.syncAll();
    expect(second).toBe(first);
    release();
    expect(await first).toEqual({ synced: 1, failed: 0, skipped: 0 });
    expect(usageRequests()).toHaveLength(1);

    // Once finished, the next call is a new run.
    await job.syncAll();
    expect(usageRequests()).toHaveLength(2);
  });

  // ---------------------------------------------------------- reminders

  it("reminds at 14 days, 3 days and on the day, once each", async () => {
    const expiresAt = NOW + 10 * DAY;
    await keep(expiresAt);
    const job = sync();

    job.remindExpiring(NOW - 5 * DAY); // 15 days out: nothing yet
    expect(alerts.recent(TENANT)).toHaveLength(0);

    job.remindExpiring(NOW);
    job.remindExpiring(NOW + DAY);
    expect(alerts.recent(TENANT)).toHaveLength(1);
    expect(alerts.recent(TENANT)[0]).toMatchObject({
      kind: "key-expiring",
      subject: "openai",
      dedupeKey: `key-expiring:openai:${expiresAt}:14`,
    });
    expect(alerts.recent(TENANT)[0]!.message).toContain("OpenAI admin key expires on 30 October 2026");

    // A fresh job (a restart) still raises nothing twice.
    sync().remindExpiring(NOW + 2 * DAY);
    expect(alerts.recent(TENANT)).toHaveLength(1);

    job.remindExpiring(expiresAt - 2 * DAY);
    sync().remindExpiring(expiresAt - DAY);
    expect(alerts.recent(TENANT)).toHaveLength(2);

    job.remindExpiring(expiresAt);
    sync().remindExpiring(expiresAt + DAY);
    const raised = alerts.recent(TENANT);
    expect(raised).toHaveLength(3);
    expect(raised.map((a) => a.dedupeKey.split(":").pop()).sort()).toEqual(["0", "14", "3"]);
    expect(raised.find((a) => a.dedupeKey.endsWith(":0"))!.message).toContain("expired on");
    expect(JSON.stringify(raised)).not.toContain(KEY);
  });

  it("starts the reminders again for a key replaced with a new expiry", async () => {
    await keep(NOW + 2 * DAY);
    const job = sync();
    job.remindExpiring(NOW);
    expect(alerts.recent(TENANT)).toHaveLength(1);

    await keep(NOW + 12 * DAY);
    job.remindExpiring(NOW);
    expect(alerts.recent(TENANT)).toHaveLength(2);
    expect(alerts.recent(TENANT).map((a) => a.dedupeKey)).toContain(`key-expiring:openai:${NOW + 12 * DAY}:14`);
  });

  it("never reminds about a key with no expiry", async () => {
    await keep(null);
    sync().remindExpiring(NOW + 1000 * DAY);
    expect(alerts.recent(TENANT)).toHaveLength(0);
  });

  it("picks the most urgent reminder that is due", () => {
    expect(reminderDue(NOW + 15 * DAY, NOW)).toBeUndefined();
    expect(reminderDue(NOW + 14 * DAY, NOW)).toBe(14);
    expect(reminderDue(NOW + 3 * DAY, NOW)).toBe(3);
    expect(reminderDue(NOW, NOW)).toBe(0);
    expect(reminderDue(NOW - DAY, NOW)).toBe(0);
  });
});
