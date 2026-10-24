import { usd } from "@costgrid/core";
import { describe, expect, it } from "vitest";
import { anthropicImporter, importerFor, openaiImporter } from "../src/importers/index.js";

/** A stub provider that serves canned pages and records what was asked for. */
function stubFetch(pages: unknown[], calls: URL[] = []): typeof fetch {
  let index = 0;
  return (async (url: unknown) => {
    calls.push(new URL(String(url)));
    const body = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const FROM = new Date("2026-06-01T00:00:00Z");
const TO = new Date("2026-06-03T00:00:00Z");

describe("anthropic importer", () => {
  const bucket = (day: string, results: unknown[]) => ({
    starting_at: `${day}T00:00:00Z`,
    ending_at: `${day}T23:59:59Z`,
    results,
  });

  it("reads disjoint token buckets and prices them from the catalog", async () => {
    const doFetch = stubFetch([
      {
        data: [
          bucket("2026-06-01", [
            {
              model: "claude-opus-5",
              uncached_input_tokens: 1_000_000,
              output_tokens: 1_000_000,
              cache_read_input_tokens: 0,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            },
          ]),
        ],
        has_more: false,
      },
    ]);

    const { rows } = await anthropicImporter.run({ apiKey: "sk-ant-admin-x", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.day).toBe("2026-06-01");
    expect(rows[0]?.usage.inputTokens).toBe(1_000_000);
    // $5 input + $25 output per MTok
    expect(rows[0]?.costCatalog).toBe(usd("30.00"));
  });

  it("keeps Anthropic's cached tokens out of the input count", async () => {
    // uncached_input_tokens EXCLUDES cached ones, unlike OpenAI's total.
    const doFetch = stubFetch([
      {
        data: [
          bucket("2026-06-01", [
            {
              model: "claude-opus-5",
              uncached_input_tokens: 200_000,
              output_tokens: 0,
              cache_read_input_tokens: 800_000,
            },
          ]),
        ],
        has_more: false,
      },
    ]);

    const { rows } = await anthropicImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows[0]?.usage.inputTokens).toBe(200_000);
    expect(rows[0]?.usage.cacheReadTokens).toBe(800_000);
    // 200k @ $5 = $1.00; 800k cache read @ $0.50 = $0.40
    expect(rows[0]?.costCatalog).toBe(usd("1.40"));
  });

  it("folds several result rows for the same day and model together", async () => {
    // The report splits a day by api key, workspace and context window.
    const doFetch = stubFetch([
      {
        data: [
          bucket("2026-06-01", [
            { model: "claude-opus-5", uncached_input_tokens: 100, output_tokens: 10 },
            { model: "claude-opus-5", uncached_input_tokens: 400, output_tokens: 40 },
            { model: "claude-haiku-4-5", uncached_input_tokens: 999, output_tokens: 1 },
          ]),
        ],
        has_more: false,
      },
    ]);

    const { rows } = await anthropicImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows).toHaveLength(2);
    const opus = rows.find((r) => r.model === "claude-opus-5");
    expect(opus?.usage.inputTokens).toBe(500);
    expect(opus?.usage.outputTokens).toBe(50);
  });

  it("asks for daily buckets grouped by model", async () => {
    // Without group_by the provider returns a null model on every row.
    const calls: URL[] = [];
    await anthropicImporter.run({
      apiKey: "k",
      from: FROM,
      to: TO,
      fetchImpl: stubFetch([{ data: [], has_more: false }], calls),
    });

    const url = calls[0]!;
    expect(url.pathname).toBe("/v1/organizations/usage_report/messages");
    expect(url.searchParams.get("bucket_width")).toBe("1d");
    expect(url.searchParams.getAll("group_by[]")).toContain("model");
    expect(url.searchParams.get("starting_at")).toBe(FROM.toISOString());
  });

  it("follows pagination", async () => {
    const calls: URL[] = [];
    const doFetch = stubFetch(
      [
        {
          data: [bucket("2026-06-01", [{ model: "claude-opus-5", uncached_input_tokens: 100 }])],
          has_more: true,
          next_page: "page_two",
        },
        {
          data: [bucket("2026-06-02", [{ model: "claude-opus-5", uncached_input_tokens: 200 }])],
          has_more: false,
        },
      ],
      calls,
    );

    const { rows } = await anthropicImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows.map((r) => r.day)).toEqual(["2026-06-01", "2026-06-02"]);
    expect(calls[1]?.searchParams.get("page")).toBe("page_two");
  });

  it("flags a model the catalog cannot price rather than recording it as free", async () => {
    const doFetch = stubFetch([
      {
        data: [
          bucket("2026-06-01", [
            { model: "claude-unreleased-9", uncached_input_tokens: 5_000_000, output_tokens: 1 },
          ]),
        ],
        has_more: false,
      },
    ]);

    const { rows, unpricedModels } = await anthropicImporter.run({
      apiKey: "k",
      from: FROM,
      to: TO,
      fetchImpl: doFetch,
    });

    expect(unpricedModels).toEqual(["claude-unreleased-9"]);
    expect(rows[0]?.priced).toBe(false);
    expect(rows[0]?.costCatalog).toBe(0n);
    expect(rows[0]?.usage.inputTokens).toBe(5_000_000); // usage still captured
  });

  it("surfaces the provider's own error message", async () => {
    const doFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "invalid admin key" } }), {
        status: 401,
      })) as unknown as typeof fetch;

    await expect(
      anthropicImporter.run({ apiKey: "bad", from: FROM, to: TO, fetchImpl: doFetch }),
    ).rejects.toThrow(/invalid admin key/);
  });
});

describe("openai importer", () => {
  const bucket = (epochSeconds: number, results: unknown[]) => ({
    object: "bucket",
    start_time: epochSeconds,
    end_time: epochSeconds + 86_400,
    results,
  });

  it("subtracts cached tokens from the inclusive input total", async () => {
    // The load-bearing difference from Anthropic: input_tokens is a TOTAL that
    // contains input_cached_tokens. Not subtracting bills them twice.
    const doFetch = stubFetch([
      {
        data: [
          bucket(Date.parse("2026-06-01T00:00:00Z") / 1000, [
            {
              model: "gpt-5",
              input_tokens: 1_000_000,
              input_cached_tokens: 900_000,
              output_tokens: 100_000,
              num_model_requests: 42,
            },
          ]),
        ],
        has_more: false,
      },
    ]);

    const { rows } = await openaiImporter.run({ apiKey: "sk-admin", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows[0]?.usage.inputTokens).toBe(100_000); // 1M total - 900k cached
    expect(rows[0]?.usage.cacheReadTokens).toBe(900_000);
    expect(rows[0]?.requests).toBe(42);
    // 100k @ $1.25 + 900k @ $0.125 + 100k @ $10 = $0.125 + $0.1125 + $1.00
    expect(rows[0]?.costCatalog).toBe(usd("1.2375"));
  });

  it("sends Unix-second timestamps, not RFC 3339", async () => {
    const calls: URL[] = [];
    await openaiImporter.run({
      apiKey: "k",
      from: FROM,
      to: TO,
      fetchImpl: stubFetch([{ data: [], has_more: false }], calls),
    });

    const url = calls[0]!;
    expect(url.pathname).toBe("/v1/organization/usage/completions");
    expect(url.searchParams.get("start_time")).toBe(String(FROM.getTime() / 1000));
    expect(url.searchParams.getAll("group_by")).toContain("model");
  });

  it("rejects a report whose cached count exceeds its total", async () => {
    const doFetch = stubFetch([
      {
        data: [
          bucket(Date.parse("2026-06-01T00:00:00Z") / 1000, [
            { model: "gpt-5", input_tokens: 100, input_cached_tokens: 500 },
          ]),
        ],
        has_more: false,
      },
    ]);

    await expect(
      openaiImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch }),
    ).rejects.toThrow(/500 cached tokens but only 100/);
  });

  it("uses Bearer auth", async () => {
    let seen: Record<string, string> = {};
    const doFetch = (async (_url: unknown, init?: RequestInit) => {
      seen = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
    }) as unknown as typeof fetch;

    await openaiImporter.run({ apiKey: "sk-admin-abc", from: FROM, to: TO, fetchImpl: doFetch });
    expect(seen["authorization"]).toBe("Bearer sk-admin-abc");
  });
});

describe("usage by source", () => {
  const DAY = Date.parse("2026-06-01T00:00:00Z") / 1000;

  it("asks Claude to group by model, key and workspace, one group_by[] each", async () => {
    const calls: URL[] = [];
    await anthropicImporter.run({
      apiKey: "k",
      from: FROM,
      to: TO,
      fetchImpl: stubFetch([{ data: [], has_more: false }], calls),
    });
    expect(calls[0]?.searchParams.getAll("group_by[]")).toEqual(["model", "api_key_id", "workspace_id"]);
  });

  it("asks OpenAI to group by model, project and key, one group_by each", async () => {
    const calls: URL[] = [];
    await openaiImporter.run({
      apiKey: "k",
      from: FROM,
      to: TO,
      fetchImpl: stubFetch([{ data: [], has_more: false }], calls),
    });
    expect(calls[0]?.searchParams.getAll("group_by")).toEqual(["model", "project_id", "api_key_id"]);
  });

  it("keeps two Claude keys apart on the same day and model, and falls back to workspace, then account", async () => {
    const doFetch = stubFetch([
      {
        data: [
          {
            starting_at: "2026-06-01T00:00:00Z",
            results: [
              { model: "claude-opus-5", api_key_id: "apikey_a", workspace_id: "wrkspc_1", uncached_input_tokens: 100 },
              { model: "claude-opus-5", api_key_id: "apikey_b", workspace_id: "wrkspc_1", uncached_input_tokens: 200 },
              // A key in the default workspace reports no workspace.
              { model: "claude-opus-5", api_key_id: "apikey_c", workspace_id: null, uncached_input_tokens: 300 },
              // Console usage, say: no key.
              { model: "claude-opus-5", api_key_id: null, workspace_id: "wrkspc_2", uncached_input_tokens: 400 },
              { model: "claude-opus-5", api_key_id: null, workspace_id: null, uncached_input_tokens: 500 },
            ],
          },
        ],
        has_more: false,
      },
    ]);

    const { rows, sources } = await anthropicImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows.map((r) => [r.sourceKind, r.sourceId, r.usage.inputTokens])).toEqual([
      ["account", "", 500],
      ["key", "apikey_a", 100],
      ["key", "apikey_b", 200],
      ["key", "apikey_c", 300],
      ["workspace", "wrkspc_2", 400],
    ]);
    expect(sources).toEqual([
      { provider: "anthropic", kind: "account", id: "" },
      { provider: "anthropic", kind: "key", id: "apikey_a", parentId: "wrkspc_1" },
      { provider: "anthropic", kind: "key", id: "apikey_b", parentId: "wrkspc_1" },
      { provider: "anthropic", kind: "key", id: "apikey_c" },
      { provider: "anthropic", kind: "workspace", id: "wrkspc_2" },
    ]);
  });

  it("splits OpenAI usage by key, else project, else account", async () => {
    const doFetch = stubFetch([
      {
        data: [
          {
            start_time: DAY,
            results: [
              { model: "gpt-5", project_id: "proj_1", api_key_id: "key_1", input_tokens: 10 },
              { model: "gpt-5", project_id: "proj_1", api_key_id: null, input_tokens: 20 },
              { model: "gpt-5", project_id: null, api_key_id: null, input_tokens: 30 },
            ],
          },
        ],
        has_more: false,
      },
    ]);

    const { rows, sources } = await openaiImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch });

    expect(rows.map((r) => [r.sourceKind, r.sourceId, r.usage.inputTokens])).toEqual([
      ["account", "", 30],
      ["key", "key_1", 10],
      ["project", "proj_1", 20],
    ]);
    expect(sources).toContainEqual({ provider: "openai", kind: "key", id: "key_1", parentId: "proj_1" });
  });

  it("prices a day's total at the standard tier, not the long-context one", async () => {
    // 1M tokens in a day passes the 272K threshold, which applies per request.
    const doFetch = stubFetch([
      {
        data: [{ start_time: DAY, results: [{ model: "gpt-6.1-sol", input_tokens: 1_000_000 }] }],
        has_more: false,
      },
    ]);
    const { rows } = await openaiImporter.run({ apiKey: "k", from: FROM, to: TO, fetchImpl: doFetch });
    expect(rows[0]?.costCatalog).toBe(usd("2.00"));
  });
});

describe("importer registry", () => {
  it("resolves both providers and nothing else", () => {
    expect(importerFor("anthropic")?.provider).toBe("anthropic");
    expect(importerFor("openai")?.provider).toBe("openai");
    expect(importerFor("bedrock")).toBeUndefined();
  });

  it("tells the customer where to find the admin key", () => {
    expect(anthropicImporter.keyHint).toMatch(/sk-ant-admin/);
    expect(openaiImporter.keyHint).toMatch(/Admin key/i);
  });
});
