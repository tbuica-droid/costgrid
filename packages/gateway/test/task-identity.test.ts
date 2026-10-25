import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveFingerprintKey } from "@costgrid/core";
import { Analytics, CostGridRepository, ImportsRepository, openDatabase, OutcomeSettingsRepository } from "@costgrid/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { FINGERPRINT_ACCOUNT, loadFingerprintKey } from "../src/fingerprint-key.js";
import { MemorySecretStore } from "../src/secret-store.js";
import { createServer } from "../src/server.js";
import { firstUserText, TaskIdentifier, turnsOf } from "../src/task-identity.js";

/**
 * Which job a proxied call belongs to. The property that matters most: the
 * message used to make the code is never stored, anywhere.
 */

const KEY = Buffer.alloc(32, 3);
const OPENING = "My parcel 99812-XQ never arrived and nobody answers";

describe("reading the first user message", () => {
  it("takes the first user text from Anthropic and OpenAI bodies, and nothing else", () => {
    expect(firstUserText({ system: "be kind", messages: [{ role: "user", content: "hello there, my order" }] })).toBe(
      "hello there, my order",
    );
    expect(
      firstUserText({
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "first part" }, { type: "text", text: "second" }] },
          { role: "user", content: "later message" },
        ],
      }),
    ).toBe("first part\nsecond");
    expect(firstUserText({ messages: [{ role: "assistant", content: "hi" }] })).toBeUndefined();
    expect(firstUserText({ messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }] })).toBeUndefined();
    expect(firstUserText(null)).toBeUndefined();
    expect(firstUserText({ input: "responses api" })).toBeUndefined();
    expect(turnsOf({ messages: [1, 2, 3] })).toBe(3);
    expect(turnsOf({})).toBeUndefined();
  });

  it("lets the developer's id win, honours the switch, and needs a key", () => {
    let on = true;
    const tasks = new TaskIdentifier({ key: KEY, enabled: () => on });
    const body = { messages: [{ role: "user", content: OPENING }] };
    expect(tasks.of("ticket-42", body, "t1")).toEqual({ taskKey: "ticket-42", taskSource: "header", turns: 1 });
    // A header that is not a safe id is ignored, not trusted.
    expect(tasks.of("<script>", body, "t1").taskSource).toBe("fingerprint");
    expect(tasks.of(undefined, body, "t1")).toEqual({ taskKey: expect.stringMatching(/^[0-9a-f]{32}$/), taskSource: "fingerprint", turns: 1 });
    // The same message in another organisation gives a different code.
    expect(tasks.of(undefined, body, "t2").taskKey).not.toBe(tasks.of(undefined, body, "t1").taskKey);
    on = false;
    expect(tasks.of(undefined, body, "t1")).toEqual({ turns: 1 });
    expect(new TaskIdentifier({ key: undefined, enabled: () => true }).of(undefined, body, "t1")).toEqual({ turns: 1 });
    expect(new TaskIdentifier({ key: undefined, enabled: () => true }).available).toBe(false);
  });
});

describe("the fingerprint key", () => {
  it("is made once in the keychain and reused", async () => {
    const store = new MemorySecretStore();
    const first = await loadFingerprintKey({ secretStore: store });
    expect(first).toHaveLength(32);
    expect(await store.get(FINGERPRINT_ACCOUNT)).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadFingerprintKey({ secretStore: store })).toEqual(first);
  });

  it("comes from the master key where there is no keychain, and is absent with neither", async () => {
    const master = Buffer.alloc(32, 9);
    expect(await loadFingerprintKey({ masterKey: master })).toEqual(deriveFingerprintKey(master));
    expect(await loadFingerprintKey({})).toBeUndefined();
    const broken = new MemorySecretStore();
    broken.get = async () => {
      throw new Error("locked");
    };
    expect(await loadFingerprintKey({ secretStore: broken, masterKey: master })).toEqual(deriveFingerprintKey(master));
  });
});

describe("recording which job a call belongs to", () => {
  const CONFIG: GatewayConfig = {
    port: 0,
    host: "127.0.0.1",
    databasePath: ":memory:",
    providerKeys: { anthropic: "sk-ant-test" },
    providerBaseUrls: {},
    upstreamTimeoutMs: 5_000,
    injectUsageRequest: true,
    extractTools: true,
    allowAnonymous: false,
    hosted: false,
    masterKeySecret: undefined,
    secureCookies: false,
    logLevel: "silent",
  };
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let app: FastifyInstance;
  let apiKey: string;

  const send = (content: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "x-costgrid-key": apiKey, "x-costgrid-agent": "support-bot", ...headers },
      payload: { model: "claude-haiku-4-5", max_tokens: 100, messages: [{ role: "user", content }] },
    });
  const rows = () =>
    db.prepare("SELECT task_key AS key, task_source AS source, turns FROM calls ORDER BY started_at, rowid").all() as {
      key: string | null;
      source: string | null;
      turns: number | null;
    }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "costgrid-task-"));
    db = openDatabase({ path: join(dir, "costgrid.db") });
    const repository = new CostGridRepository(db);
    repository.createTenant("Acme", "t1");
    apiKey = repository.createApiKey("t1", "svc").plaintext;
    app = createServer({
      config: CONFIG,
      db,
      repository,
      analytics: new Analytics(db),
      imports: new ImportsRepository(db),
      fingerprintKey: KEY,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ model: "claude-haiku-4-5", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
  });

  afterEach(async () => {
    await app?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives the same job the same code, and never keeps the message", async () => {
    expect((await send(OPENING)).statusCode).toBe(200);
    await send(`  ${OPENING.toUpperCase()} `);
    await send("A completely different question about invoices");
    await send(OPENING, { "x-costgrid-task": "ticket-7" });

    const [a, b, c, d] = rows();
    expect(a).toEqual({ key: expect.stringMatching(/^[0-9a-f]{32}$/), source: "fingerprint", turns: 1 });
    expect(b!.key).toBe(a!.key);
    expect(c!.key).not.toBe(a!.key);
    expect(d).toEqual({ key: "ticket-7", source: "header", turns: 1 });

    // Not in any table, and not in any byte of the database or its journal.
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()).toLowerCase(), name).not.toContain("99812");
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes(Buffer.from("99812")), file).toBe(false);
    }
  });

  it("stops making codes when the owner turns matching off", async () => {
    new OutcomeSettingsRepository(db).setFingerprint("t1", false);
    await send(OPENING);
    await send(OPENING, { "x-costgrid-task": "ticket-8" });
    expect(rows()).toEqual([
      { key: null, source: null, turns: 1 },
      { key: "ticket-8", source: "header", turns: 1 },
    ]);
  });
});
