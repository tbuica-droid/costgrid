import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { usd } from "@costgrid/core";
import { describe, expect, it } from "vitest";
import {
  MAX_DATA_ROWS,
  MAX_FILE_CHARS,
  normaliseHeader,
  parseCsv,
  parseUsageFile,
  UsageFileError,
} from "../src/importers/csv.js";

/**
 * Usage files as an owner downloads them. Every fixture is synthetic: the
 * headers are the providers' real ones, the numbers are chosen to make the
 * arithmetic checkable by hand, and no customer's data is in the repository.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "usage");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const CLAUDE_HEADER =
  "usage_date_utc,model_version,api_key,workspace,usage_type,context_window,usage_input_tokens_no_cache," +
  "usage_input_tokens_cache_write_5m,usage_input_tokens_cache_write_1h,usage_input_tokens_cache_read," +
  "usage_output_tokens,web_search_count,inference_geo,speed";
const OPENAI_HEADER =
  "start_time,end_time,start_time_iso,end_time_iso,input_tokens,output_tokens,num_model_requests," +
  "project_id,user_id,api_key_id,model,batch,service_tier,input_cached_tokens,input_uncached_tokens";

/** Assert the parse fails with a UsageFileError carrying this code. */
function failure(provider: "anthropic" | "openai", text: string): UsageFileError {
  try {
    parseUsageFile(provider, text);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageFileError);
    return error as UsageFileError;
  }
  throw new Error("expected the file to be refused");
}

describe("CSV parsing", () => {
  it("handles quotes, escaped quotes, line breaks inside quotes and CRLF", () => {
    const records = parseCsv('a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\n1,2,3', ",");
    expect(records).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "two\nlines"],
      ["1", "2", "3"],
    ]);
  });

  it("treats a lone CR as a line end and keeps an empty last field", () => {
    expect(parseCsv("a,b\r1,", ",")).toEqual([
      ["a", "b"],
      ["1", ""],
    ]);
  });

  it("matches headers by name, whatever a spreadsheet did to them", () => {
    expect(normaliseHeader("Usage Date (UTC)")).toBe("usage_date_utc");
    expect(normaliseHeader("  input-cached tokens ")).toBe("input_cached_tokens");
  });

  it("reads a tab-delimited file", () => {
    const text = `${CLAUDE_HEADER.replace(/,/g, "\t")}\n2026-09-05\tclaude-sonnet-4-6\twriter\tContent\tstandard\t≤ 200k\t1000000\t0\t0\t0\t0\t0\tglobal\t\n`;
    const { rows } = parseUsageFile("anthropic", text);
    expect(rows[0]?.costCatalog).toBe(usd("3.00"));
  });

  it("finds columns by name, not position", () => {
    // The same row with the columns reversed must mean the same thing.
    const header = CLAUDE_HEADER.split(",");
    const cells = "2026-09-05,claude-sonnet-4-6,writer,Content,standard,≤ 200k,1000000,0,0,0,0,0,global,".split(",");
    const reversed = `${[...header].reverse().join(",")}\n${[...cells].reverse().join(",")}\n`;
    const { rows, sources } = parseUsageFile("anthropic", reversed);
    expect(rows[0]?.costCatalog).toBe(usd("3.00"));
    expect(sources[0]).toMatchObject({ kind: "key", id: "Content / writer", parentId: "Content" });
  });
});

describe("Claude usage export", () => {
  it("reads the current format, priced with its modifiers, by key and workspace", () => {
    const result = parseUsageFile("anthropic", fixture("claude_api_tokens_current.csv"));

    expect(result.fromDay).toBe("2026-09-01");
    expect(result.toDay).toBe("2026-09-02");
    expect(result.unpricedModels).toEqual([]);
    expect(result.rows.map((r) => [r.day, r.model, r.sourceKind, r.sourceId, r.costCatalog])).toEqual([
      // Fast mode ($10/$50, cache read 0.1x of that), then US-only inference at 1.1x.
      ["2026-09-01", "claude-opus-5", "key", "Sales / lead-scorer", usd("2.75")],
      // $3 + $1.50, plus 200k long-context tokens at the standard $3: no long rate is catalogued.
      ["2026-09-01", "claude-sonnet-4-6", "key", "Support / support-bot", usd("5.10")],
      // Batch: half of $2.
      ["2026-09-02", "claude-haiku-4-5", "workspace", "Ops", usd("1.00")],
    ]);
    expect(result.rows[1]?.usage.inputTokens).toBe(1_200_000);
    expect(result.rows.every((r) => r.provider === "anthropic" && r.requests === 0)).toBe(true);

    expect(result.sources).toEqual([
      { provider: "anthropic", kind: "key", id: "Sales / lead-scorer", parentId: "Sales" },
      { provider: "anthropic", kind: "key", id: "Support / support-bot", parentId: "Support" },
      { provider: "anthropic", kind: "workspace", id: "Ops" },
    ]);
    expect(result.warnings.some((w) => /web searches/i.test(w))).toBe(true);
    expect(result.warnings.some((w) => /claude-sonnet-4-6: long-context/.test(w))).toBe(true);
  });

  it("reads the 2025 format with a BOM, CRLF, quoted names, hourly dates and -- cells", () => {
    const result = parseUsageFile("anthropic", fixture("claude_api_tokens_2025_hourly.csv"));

    expect(result.fromDay).toBe("2025-11-03");
    expect(result.toDay).toBe("2025-11-03");
    expect(result.rows).toHaveLength(2);

    const key = result.rows.find((r) => r.sourceKind === "key")!;
    expect(key.sourceId).toBe('Main "prod" / Support, EU');
    expect(key.usage).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheWrite5mTokens: 100_000,
      cacheWrite1hTokens: 100_000,
      cacheReadTokens: 0,
    });
    // $3 + 100k at $3.75 + 100k at $6 + $1.50
    expect(key.costCatalog).toBe(usd("5.475"));
    expect(result.sources).toContainEqual({
      provider: "anthropic",
      kind: "key",
      id: 'Main "prod" / Support, EU',
      parentId: 'Main "prod"',
    });

    // No key and no workspace: the account's.
    const account = result.rows.find((r) => r.sourceKind === "account")!;
    expect(account.sourceId).toBe("");
    expect(account.costCatalog).toBe(usd("0.003"));
  });

  it("reads a semicolon-delimited file", () => {
    const { rows } = parseUsageFile("anthropic", fixture("claude_api_tokens_semicolon.csv"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ day: "2026-09-05", sourceKind: "key", sourceId: "Content / writer" });
    expect(rows[0]?.costCatalog).toBe(usd("3.00"));
  });

  it("treats a header with no rows as no usage", () => {
    const result = parseUsageFile("anthropic", fixture("claude_api_tokens_no_usage.csv"));
    expect(result).toMatchObject({ rows: [], sources: [], fromDay: null, toDay: null });
  });

  it("names a model the catalog cannot price instead of calling it free", () => {
    const text = `${CLAUDE_HEADER}\n2026-09-01,claude-unreleased-9,k,w,standard,≤ 200k,10,0,0,0,0,0,global,\n`;
    const result = parseUsageFile("anthropic", text);
    expect(result.unpricedModels).toEqual(["claude-unreleased-9"]);
    expect(result.rows[0]).toMatchObject({ priced: false, costCatalog: 0n });
  });
});

describe("OpenAI activity export", () => {
  it("reads the 2025 column order by key, project and account", () => {
    const result = parseUsageFile("openai", fixture("completions_usage_2025_order.csv"));

    expect(result.fromDay).toBe("2026-09-01");
    expect(result.toDay).toBe("2026-09-03");
    expect(result.rows.map((r) => [r.day, r.model, r.sourceKind, r.sourceId, r.requests, r.costCatalog])).toEqual([
      // 100k uncached at $1.25, 900k cached at $0.125, 100k out at $10
      ["2026-09-01", "gpt-5", "key", "key_alpha1", 42, usd("1.2375")],
      // Batch: half of 2M at $0.25
      ["2026-09-01", "gpt-5-mini", "project", "proj_alpha", 10, usd("0.25")],
      ["2026-09-03", "gpt-4o-mini", "account", "", 5, usd("0.15")],
    ]);
    expect(result.sources).toEqual([
      { provider: "openai", kind: "account", id: "" },
      { provider: "openai", kind: "key", id: "key_alpha1", parentId: "proj_alpha" },
      { provider: "openai", kind: "project", id: "proj_alpha" },
    ]);
    expect(result.warnings.some((w) => /flex/.test(w))).toBe(true);
  });

  it("reads the 2026 column order, and prices a day's total at the standard tier", () => {
    // 2M tokens in a day is past the 272K long-context threshold, but that
    // threshold is per request. Priced per day it would double the bill.
    const result = parseUsageFile("openai", fixture("completions_usage_2026_order.csv"));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ model: "gpt-6.1-sol", sourceKind: "key", sourceId: "key_beta1", requests: 3 });
    expect(result.rows[0]?.costCatalog).toBe(usd("12.00"));
    expect(result.warnings.some((w) => /audio/i.test(w))).toBe(true);
  });

  it("reads the 2026-08 columns, cache writes included", () => {
    const { rows } = parseUsageFile("openai", fixture("completions_usage_2026_08.csv"));
    expect(rows[0]?.usage).toMatchObject({ inputTokens: 700_000, cacheWrite5mTokens: 100_000, cacheReadTokens: 200_000 });
    // 700k at $2 + 100k written at $2.50 + 200k read at $0.10
    expect(rows[0]?.costCatalog).toBe(usd("1.67"));
  });

  it("reads an ungrouped export with no id columns as the account's", () => {
    const { rows, sources } = parseUsageFile("openai", fixture("completions_usage_ungrouped.csv"));
    // No input_uncached_tokens column: input minus cached.
    expect(rows[0]).toMatchObject({ sourceKind: "account", sourceId: "", requests: 12 });
    expect(rows[0]?.usage).toMatchObject({ inputTokens: 600_000, cacheReadTokens: 400_000 });
    expect(rows[0]?.costCatalog).toBe(usd("0.80"));
    expect(sources).toEqual([{ provider: "openai", kind: "account", id: "" }]);
  });

  it("treats a file of empty buckets as no usage, over the days the buckets cover", () => {
    const result = parseUsageFile("openai", fixture("completions_usage_no_usage.csv"));
    expect(result).toMatchObject({ rows: [], sources: [], fromDay: "2026-09-01", toDay: "2026-09-03" });
  });

  it("folds minute buckets into UTC days", () => {
    const result = parseUsageFile("openai", fixture("completions_usage_minutes.csv"));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ day: "2026-09-10", requests: 2 });
    expect(result.rows[0]?.usage.inputTokens).toBe(1_000_000);
    expect(result).toMatchObject({ fromDay: "2026-09-10", toDay: "2026-09-10" });
  });
});

describe("refusals", () => {
  it("recognises both cost exports and asks for the usage one", () => {
    const openai = failure("openai", fixture("cost_2026-09-01_2026-09-30.csv"));
    expect(openai.code).toBe("cost-file");
    expect(openai.message).toMatch(/activity export/);

    const claude = failure("anthropic", fixture("claude_api_cost_example.csv"));
    expect(claude.code).toBe("cost-file");
    expect(claude.message).toMatch(/claude_api_tokens/);
  });

  it("refuses an empty file", () => {
    expect(failure("anthropic", "").code).toBe("empty");
    expect(failure("openai", "﻿ \r\n").code).toBe("empty");
  });

  it("refuses something that is not a CSV", () => {
    expect(failure("anthropic", "PK\u0003\u0004binary").code).toBe("not-csv");
    expect(failure("anthropic", "<!doctype html><p>sign in</p>").code).toBe("not-csv");
    expect(failure("anthropic", "just one column\nvalue\n").code).toBe("not-csv");
    expect(failure("anthropic", `${CLAUDE_HEADER}\n"unterminated,1\n`).code).toBe("not-csv");
  });

  it("refuses a file over the size or row limits", () => {
    expect(failure("openai", "a".repeat(MAX_FILE_CHARS + 1)).code).toBe("too-large");
    const bucket = "1788220800,1788307200\n";
    expect(failure("openai", `start_time,end_time\n${bucket.repeat(MAX_DATA_ROWS + 1)}`).code).toBe("too-large");
  });

  it("names the columns that are missing", () => {
    const noOutput = CLAUDE_HEADER.replace(",usage_output_tokens", "");
    const error = failure("anthropic", `${noOutput}\n`);
    expect(error.code).toBe("missing-columns");
    expect(error.missing).toEqual(["usage_output_tokens"]);

    const unrelated = failure("openai", "name,email\na,b\n");
    expect(unrelated).toMatchObject({ code: "missing-columns", missing: ["start_time"] });

    const noModel = failure("openai", "start_time,end_time,input_tokens,output_tokens\n1788220800,1,1.0,1.0\n");
    expect(noModel).toMatchObject({ code: "missing-columns", missing: ["model"] });
  });

  it("refuses a fraction of a token, a negative count or a bad date, naming the row", () => {
    const half = failure("anthropic", `${CLAUDE_HEADER}\n2026-09-01,claude-opus-5,k,w,standard,≤ 200k,12.5,0,0,0,0,0,global,\n`);
    expect(half).toMatchObject({ code: "bad-value", row: 2 });
    expect(half.message).toMatch(/Row 2/);

    const fraction = failure("openai", `${OPENAI_HEADER}\n1788220800,1788307200,,,123.5,0.0,1.0,p,,k,gpt-5,False,default,0.0,\n`);
    expect(fraction).toMatchObject({ code: "bad-value", row: 2 });

    const negative = failure("anthropic", `${CLAUDE_HEADER}\n2026-09-01,claude-opus-5,k,w,standard,≤ 200k,-5,0,0,0,0,0,global,\n`);
    expect(negative.code).toBe("bad-value");

    const moreCached = failure("openai", `${OPENAI_HEADER}\n1788220800,1788307200,,,100.0,0.0,1.0,p,,k,gpt-5,False,default,500.0,\n`);
    expect(moreCached.code).toBe("bad-value");

    const date = failure("anthropic", `${CLAUDE_HEADER}\nyesterday,claude-opus-5,k,w,standard,≤ 200k,5,0,0,0,0,0,global,\n`);
    expect(date).toMatchObject({ code: "bad-value", row: 2 });
  });

  it("refuses a date a spreadsheet has made ambiguous", () => {
    const error = failure("anthropic", `${CLAUDE_HEADER}\n03/09/2026,claude-opus-5,k,w,standard,≤ 200k,5,0,0,0,0,0,global,\n`);
    expect(error).toMatchObject({ code: "ambiguous-date", row: 2 });
  });

  it("notices a file uploaded under the wrong provider", () => {
    expect(failure("openai", fixture("claude_api_tokens_current.csv")).code).toBe("wrong-provider");
    expect(failure("anthropic", fixture("completions_usage_2025_order.csv")).code).toBe("wrong-provider");
    expect(failure("anthropic", fixture("completions_usage_no_usage.csv")).code).toBe("wrong-provider");

    const gpt = failure("anthropic", `${CLAUDE_HEADER}\n2026-09-01,gpt-4o,k,w,standard,≤ 200k,5,0,0,0,0,0,global,\n`);
    expect(gpt).toMatchObject({ code: "wrong-provider", row: 2 });
    const claude = failure("openai", `${OPENAI_HEADER}\n1788220800,1788307200,,,5.0,0.0,1.0,p,,k,claude-opus-5,False,default,0.0,5.0\n`);
    expect(claude).toMatchObject({ code: "wrong-provider", row: 2 });

    expect(failure("bedrock" as "openai", fixture("completions_usage_no_usage.csv")).code).toBe("wrong-provider");
  });
});
