import { usd, ZERO_USAGE } from "@costgrid/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Db,
  type ImportedRow,
  ImportsRepository,
  openDatabase,
  SourcesRepository,
} from "../src/index.js";

/**
 * Imported usage per source, and the sources an owner names.
 *
 * The property that matters most: the same usage is never counted twice.
 * History imported before sources existed was summed across every key; once
 * the same days arrive per key, the old sum must go rather than add up.
 */

const T = "t1";
const WINDOW = { fromDay: "2026-06-01", toDay: "2026-06-03" };

function row(day: string, cost: string, source: Partial<ImportedRow> = {}): ImportedRow {
  return {
    provider: "anthropic",
    day,
    model: "claude-opus-5",
    usage: { ...ZERO_USAGE, inputTokens: 1000 },
    requests: 0,
    costCatalog: usd(cost),
    priced: true,
    ...source,
  };
}

function total(db: Db, provider = "anthropic"): bigint {
  const result = db
    .prepare("SELECT COALESCE(SUM(cost_catalog), 0) AS total FROM imported_usage WHERE tenant_id = ? AND provider = ?")
    .safeIntegers(true)
    .get(T, provider) as { total: bigint };
  return result.total;
}

describe("imports by source", () => {
  let db: Db;
  let imports: ImportsRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0)").run(T);
    imports = new ImportsRepository(db);
  });

  it("keeps two sources apart on the same day and model", () => {
    imports.putRows(
      T,
      "anthropic",
      WINDOW,
      [
        row("2026-06-01", "1.00", { sourceKind: "key", sourceId: "apikey_a" }),
        row("2026-06-01", "2.00", { sourceKind: "key", sourceId: "apikey_b" }),
      ],
      "admin-api",
    );
    expect(total(db)).toBe(usd("3.00"));
  });

  it("replaces the window, so an old summed row and per-key rows never add up", () => {
    // What a pre-source import left: one row for the account, summed.
    imports.putRows(T, "anthropic", WINDOW, [row("2026-06-02", "3.00")], "admin-api");
    // Outside the window, and another provider: both must survive.
    imports.putRows(T, "anthropic", { fromDay: "2026-05-30", toDay: "2026-05-30" }, [row("2026-05-30", "9.00")], "csv");
    imports.putRows(
      T,
      "openai",
      WINDOW,
      [row("2026-06-02", "4.00", { provider: "openai", model: "gpt-5" })],
      "admin-api",
    );

    const written = imports.putRows(
      T,
      "anthropic",
      WINDOW,
      [
        row("2026-06-02", "1.00", { sourceKind: "key", sourceId: "apikey_a" }),
        row("2026-06-02", "2.00", { sourceKind: "key", sourceId: "apikey_b" }),
      ],
      "csv",
    );

    expect(written).toBe(2);
    // $3 per key plus the untouched $9 day: not $3 + $3 + $9.
    expect(total(db)).toBe(usd("12.00"));
    expect(total(db, "openai")).toBe(usd("4.00"));
    const origins = db
      .prepare("SELECT DISTINCT origin, source_kind FROM imported_usage WHERE provider = 'anthropic' AND day = '2026-06-02'")
      .all();
    expect(origins).toEqual([{ origin: "csv", source_kind: "key" }]);
  });

  it("clears the window even when the new import found nothing", () => {
    imports.putRows(T, "anthropic", WINDOW, [row("2026-06-02", "3.00")], "admin-api");
    expect(imports.putRows(T, "anthropic", WINDOW, [], "csv")).toBe(0);
    expect(imports.hasImports(T)).toBe(false);
  });

  it("widens the window to a day the provider answered for", () => {
    imports.putRows(T, "anthropic", WINDOW, [row("2026-06-04", "5.00")], "admin-api");
    imports.putRows(T, "anthropic", WINDOW, [row("2026-06-04", "6.00")], "admin-api");
    expect(total(db)).toBe(usd("6.00"));
  });

  it("refuses rows for another provider, and a window that is not one, writing nothing", () => {
    expect(() =>
      imports.putRows(T, "anthropic", WINDOW, [row("2026-06-01", "1.00", { provider: "openai" })], "csv"),
    ).toThrow(/openai row/);
    expect(() => imports.putRows(T, "anthropic", { fromDay: "2026-06-03", toDay: "2026-06-01" }, [], "csv")).toThrow();
    expect(() => imports.putRows(T, "anthropic", { fromDay: "June", toDay: "2026-06-01" }, [], "csv")).toThrow();
    expect(imports.hasImports(T)).toBe(false);
  });

  it("records how each run arrived", () => {
    const id = imports.startRun(T, "openai", "2026-06-01", "2026-06-03", "csv");
    imports.finishRun(id, 2);
    expect(imports.recentRuns(T)[0]).toMatchObject({ id, origin: "csv", status: "ok", rowsWritten: 2 });
  });
});

describe("SourcesRepository", () => {
  let db: Db;
  let sources: SourcesRepository;
  let imports: ImportsRepository;

  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Acme', 0), ('t2', 'Other', 0)").run(T);
    sources = new SourcesRepository(db);
    imports = new ImportsRepository(db);
  });

  it("records sources, widening their days and keeping a label once found", () => {
    sources.upsertSources(
      T,
      [
        { provider: "anthropic", kind: "key", id: "apikey_a", parentId: "wrkspc_1", label: "support-bot" },
        { provider: "anthropic", kind: "account", id: "ignored" },
      ],
      { first: "2026-06-02", last: "2026-06-03" },
    );
    // A later file has no label or parent: what was known stays.
    sources.upsertSources(T, [{ provider: "anthropic", kind: "key", id: "apikey_a" }], {
      first: "2026-06-01",
      last: "2026-06-02",
    });

    const list = sources.list(T, { from: "2026-01-01", to: "2026-12-31" });
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.kind === "key")).toEqual({
      provider: "anthropic",
      kind: "key",
      id: "apikey_a",
      parentId: "wrkspc_1",
      label: "support-bot",
      name: null,
      purposeId: null,
      purposeVersion: null,
      firstDay: "2026-06-01",
      lastDay: "2026-06-03",
      costNano: 0n,
    });
    // The account's id is always ''.
    expect(list.find((s) => s.kind === "account")?.id).toBe("");
    expect(sources.count(T)).toBe(2);
    expect(sources.count("t2")).toBe(0);
  });

  it("sums each source's cost in the range, the provider's figure first", () => {
    sources.upsertSources(
      T,
      [
        { provider: "anthropic", kind: "key", id: "apikey_a" },
        { provider: "anthropic", kind: "key", id: "apikey_b" },
        { provider: "openai", kind: "project", id: "proj_1" },
      ],
      { first: "2026-06-01", last: "2026-06-03" },
    );
    imports.putRows(
      T,
      "anthropic",
      WINDOW,
      [
        row("2026-06-01", "1.00", { sourceKind: "key", sourceId: "apikey_a" }),
        row("2026-06-03", "2.00", { sourceKind: "key", sourceId: "apikey_a", model: "claude-haiku-4-5" }),
        row("2026-06-02", "5.00", { sourceKind: "key", sourceId: "apikey_b", costReported: usd("4.00") }),
      ],
      "admin-api",
    );

    const june = sources.list(T, { from: "2026-06-01", to: "2026-06-03" });
    expect(june.map((s) => [s.id, s.costNano])).toEqual([
      ["apikey_b", usd("4.00")],
      ["apikey_a", usd("3.00")],
      ["proj_1", 0n],
    ]);
    const firstDay = sources.list(T, { from: "2026-06-01", to: "2026-06-01" });
    expect(firstDay.find((s) => s.id === "apikey_a")?.costNano).toBe(usd("1.00"));
    expect(() => sources.list(T, { from: "2026-06-03", to: "2026-06-01" })).toThrow();
  });

  it("names a source and records its purpose, changing only what is given", () => {
    sources.upsertSources(T, [{ provider: "openai", kind: "project", id: "proj_1" }], {
      first: "2026-06-01",
      last: "2026-06-01",
    });

    expect(sources.setNameAndPurpose(T, "openai", "project", "proj_1", { name: "  Support bot " })).toBe(true);
    expect(
      sources.setNameAndPurpose(T, "openai", "project", "proj_1", { purposeId: "support", purposeVersion: "1" }),
    ).toBe(true);
    let [source] = sources.list(T, { from: "2026-06-01", to: "2026-06-01" });
    expect(source).toMatchObject({ name: "Support bot", purposeId: "support", purposeVersion: "1" });

    // Empty clears.
    sources.setNameAndPurpose(T, "openai", "project", "proj_1", { purposeId: "" });
    [source] = sources.list(T, { from: "2026-06-01", to: "2026-06-01" });
    expect(source).toMatchObject({ name: "Support bot", purposeId: null, purposeVersion: null });

    expect(sources.setNameAndPurpose(T, "openai", "project", "proj_404", { name: "x" })).toBe(false);
    expect(sources.setNameAndPurpose("t2", "openai", "project", "proj_1", { name: "x" })).toBe(false);
    expect(sources.setNameAndPurpose(T, "openai", "project", "proj_1", {})).toBe(true);
  });

  it("keeps admin-key metadata, records syncs, and forgets on request", () => {
    sources.putAdminKey(T, { provider: "anthropic", hint: "sk-ant-…abcd", expiresAt: 2_000, createdAt: 1_000 });
    sources.putAdminKey("t2", { provider: "openai", hint: "sk-…wxyz", expiresAt: null, createdAt: 1_500 });

    sources.recordSync(T, "anthropic", false, "provider returned 401: invalid key");
    expect(sources.adminKeys(T)).toEqual([
      {
        provider: "anthropic",
        hint: "sk-ant-…abcd",
        expiresAt: 2_000,
        createdAt: 1_000,
        lastSyncAt: expect.any(Number),
        lastSyncStatus: "error",
        lastSyncError: "provider returned 401: invalid key",
      },
    ]);
    sources.recordSync(T, "anthropic", true);
    expect(sources.adminKeys(T)[0]).toMatchObject({ lastSyncStatus: "ok", lastSyncError: null });

    // A replacement key starts its history afresh.
    sources.putAdminKey(T, { provider: "anthropic", hint: "sk-ant-…efgh", expiresAt: 3_000, createdAt: 2_500 });
    expect(sources.adminKeys(T)[0]).toMatchObject({ hint: "sk-ant-…efgh", lastSyncAt: null, lastSyncStatus: null });

    expect(sources.allAdminKeys().map((k) => [k.tenantId, k.provider, k.expiresAt])).toEqual([
      [T, "anthropic", 3_000],
      ["t2", "openai", null],
    ]);

    expect(sources.deleteAdminKey(T, "anthropic")).toBe(true);
    expect(sources.deleteAdminKey(T, "anthropic")).toBe(false);
    expect(sources.adminKeys(T)).toEqual([]);
  });

  it("goes with the tenant", () => {
    sources.putAdminKey(T, { provider: "anthropic", hint: "h", expiresAt: null, createdAt: 1 });
    sources.upsertSources(T, [{ provider: "anthropic", kind: "workspace", id: "w" }], {
      first: "2026-06-01",
      last: "2026-06-01",
    });
    db.prepare("DELETE FROM tenants WHERE id = ?").run(T);
    expect(sources.count(T)).toBe(0);
    expect(sources.allAdminKeys()).toEqual([]);
  });
});
