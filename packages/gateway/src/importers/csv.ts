import type { Provider, TokenUsage } from "@costgrid/core";
import { type ImportResult, type PricingVariant, RowAccumulator, sourceOf, utcDay } from "./index.js";

/**
 * Reading the usage file an owner downloads from a provider's console.
 *
 * The route for someone with no admin key: Claude Console → Usage → Export
 * (`claude_api_tokens_*.csv`) or OpenAI Platform → Usage → Export
 * (`completions_usage_*.csv`). Both providers add columns over time and the
 * two disagree on almost everything, so columns are found **by header name,
 * never by position**, and a file is recognised by the columns it has rather
 * than by its file name.
 *
 * The text arrives from a browser upload, so this is a trust boundary: every
 * cell is validated, sizes are capped, and every refusal says in plain words
 * what was wrong and on which row (header = row 1, as in a spreadsheet).
 * Rows are priced by the same accumulator as the admin-API import.
 */

export type UsageFileErrorCode =
  | "empty" | "not-csv" | "too-large" | "missing-columns"
  | "bad-value" | "wrong-provider" | "cost-file" | "ambiguous-date";

export class UsageFileError extends Error {
  readonly code: UsageFileErrorCode;
  /** Normalised names of the columns a recognised export lacks. */
  readonly missing?: string[];
  /** The spreadsheet row: the header is row 1. */
  readonly row?: number;

  constructor(
    code: UsageFileErrorCode,
    message: string,
    extra: { missing?: string[]; row?: number } = {},
  ) {
    super(message);
    this.name = "UsageFileError";
    this.code = code;
    if (extra.missing !== undefined) this.missing = extra.missing;
    if (extra.row !== undefined) this.row = extra.row;
  }
}

export type UsageFileResult = ImportResult & {
  readonly fromDay: string | null;
  readonly toDay: string | null;
  readonly warnings: string[];
};

/** Far above any real export; a cap on what one upload can make the server parse. */
export const MAX_FILE_CHARS = 32 * 1024 * 1024;
export const MAX_DATA_ROWS = 200_000;

const NAMES: Record<Provider, string> = { anthropic: "Claude", openai: "OpenAI", bedrock: "Bedrock", vertex: "Vertex" };

// ------------------------------------------------------------------ parser

/** The likeliest delimiter: whichever of , ; or tab appears most in the header. */
function detectDelimiter(text: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  for (const [delimiter, count] of counts) if (count > counts.get(best)!) best = delimiter;
  return best;
}

/**
 * RFC 4180, plus what spreadsheets actually write: quoted fields with `""`
 * escapes and line breaks inside them, CRLF or LF line ends, and a choice of
 * delimiter. Blank lines are skipped. Stops once there are more records than
 * `limit`, so a huge file costs no more than the refusal needs.
 */
export function parseCsv(text: string, delimiter: string, limit = Number.POSITIVE_INFINITY): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endRecord = (): void => {
    record.push(field);
    if (record.length > 1 || record[0] !== "") records.push(record);
    record = [];
    field = "";
  };

  while (i < text.length && records.length <= limit) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else field += ch;
    i++;
  }
  if (quoted) {
    throw new UsageFileError(
      "not-csv",
      "The file ends inside a quoted value, so it looks cut short or damaged.",
    );
  }
  if (field !== "" || record.length > 0) endRecord();
  return records;
}

/** `Usage Date (UTC)` and `usage_date_utc` are the same column. */
export function normaliseHeader(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** A data row, read by column name. */
class Row {
  constructor(
    readonly number: number,
    private readonly cells: readonly string[],
    private readonly columns: ReadonlyMap<string, number>,
  ) {}

  has(column: string): boolean {
    return this.columns.has(column);
  }

  /** The trimmed cell, with `--` and blanks as "". */
  text(column: string): string {
    const index = this.columns.get(column);
    const value = index === undefined ? "" : (this.cells[index] ?? "").trim();
    return value === "--" ? "" : value;
  }

  /**
   * A whole, non-negative count. `123.0` is accepted because OpenAI writes
   * every count that way; `123.5` is not, because half a token is a damaged
   * file, not a rounding question.
   */
  count(column: string): number {
    const cell = this.text(column);
    // A spreadsheet may have added thousands separators: 1,234,567.
    const raw = /^\d{1,3}(,\d{3})+(\.0+)?$/.test(cell) ? cell.replace(/,/g, "") : cell;
    if (raw === "") return 0;
    if (!/^\d+(\.0+)?$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new UsageFileError(
        "bad-value",
        `Row ${this.number}: "${cell.slice(0, 40)}" in ${column} is not a whole number of tokens.`,
        { row: this.number },
      );
    }
    return Number(raw);
  }
}

// ------------------------------------------------------------------- dates

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]00:?00)?)?$/;

/** `YYYY-MM-DD`, optionally with a time (hourly exports), folded to the day. */
function dayOf(value: string, row: Row, column: string): string {
  const day = ISO_DAY.exec(value)?.[1];
  // The round trip rejects a day that does not exist, such as 2026-02-30.
  const midnight = `${day}T00:00:00Z`;
  if (day !== undefined && !Number.isNaN(Date.parse(midnight)) && utcDay(midnight) === day) return day;

  if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(value)) {
    throw new UsageFileError(
      "ambiguous-date",
      `Row ${row.number}: the date "${value.slice(0, 40)}" is not written as YYYY-MM-DD, and could be ` +
        "day-first or month-first. This happens when a spreadsheet re-saves the file. Download the " +
        "export again and upload it without opening it.",
      { row: row.number },
    );
  }
  throw new UsageFileError(
    "bad-value",
    `Row ${row.number}: "${value.slice(0, 40)}" in ${column} is not a date.`,
    { row: row.number },
  );
}

// ----------------------------------------------------------------- formats

type Format = "claude-usage" | "openai-usage" | "claude-cost" | "openai-cost";

/** Which export this is, from the columns alone. Cost exports are checked first. */
function detect(has: (column: string) => boolean): Format | undefined {
  if (has("cost_usd") && (has("token_type") || has("usage_date_utc"))) return "claude-cost";
  if (has("amount_value") && (has("amount_currency") || has("line_item"))) return "openai-cost";
  if (has("usage_date_utc")) return "claude-usage";
  if (has("start_time") || has("start_time_iso")) return "openai-usage";
  return undefined;
}

const OTHER_PROVIDER_MODEL: Record<"anthropic" | "openai", RegExp> = {
  anthropic: /^(gpt-|o\d|chatgpt|text-|dall-e|whisper|tts-|davinci|babbage|codex)/i,
  openai: /^claude/i,
};

/** Collects warnings once each, so a file with a thousand flex rows says it once. */
class Notes {
  readonly #notes = new Set<string>();
  add(note: string): void {
    if (this.#notes.size < 20) this.#notes.add(note);
  }
  get list(): string[] {
    return [...this.#notes];
  }
}

const CLAUDE_REQUIRED = ["usage_date_utc", "model_version", "usage_input_tokens_no_cache", "usage_output_tokens"];

/**
 * Claude Console's token export: one row per day (or hour, for a single-day
 * export) × model × key × workspace × usage type × context window ×
 * geography × speed. The key and workspace are **names**, which is all the
 * file has, so they become the source ids.
 */
function readClaude(
  rows: readonly Row[],
  acc: RowAccumulator,
  notes: Notes,
  days: Set<string>,
): void {
  for (const row of rows) {
    const day = dayOf(row.text("usage_date_utc"), row, "usage_date_utc");
    const usage: TokenUsage = {
      inputTokens: row.count("usage_input_tokens_no_cache"),
      outputTokens: row.count("usage_output_tokens"),
      cacheWrite5mTokens: row.count("usage_input_tokens_cache_write_5m"),
      cacheWrite1hTokens: row.count("usage_input_tokens_cache_write_1h"),
      cacheReadTokens: row.count("usage_input_tokens_cache_read"),
    };
    days.add(day);
    const model = row.text("model_version");
    if (model !== "" && OTHER_PROVIDER_MODEL.anthropic.test(model)) {
      throw wrongModel("anthropic", model, row);
    }
    if (row.count("web_search_count") > 0) {
      notes.add("Web searches are not included: the price list covers tokens only.");
    }
    if (isEmpty(usage)) continue;

    // Keys are named, not identified, and names repeat across workspaces.
    const [keyName, workspace] = [row.text("api_key"), row.text("workspace")];
    const source = sourceOf(keyName && workspace ? `${workspace} / ${keyName}` : keyName, workspace, "workspace");
    // The export has no request count; zero is honest, as for the admin API.
    acc.add(day, model || "unknown", source, usage, 0, claudeVariant(row, notes));
  }
}

function isEmpty(usage: TokenUsage): boolean {
  return Object.values(usage).every((n) => n === 0);
}

/** The billing modifiers a Claude row carries, mapped onto the ones the catalog prices. */
function claudeVariant(row: Row, notes: Notes): PricingVariant {
  const modifiers: { speed?: "fast"; inferenceGeo?: "us"; batch?: boolean } = {};

  // Fast mode on a model without a fast rate bills at standard, as the API does.
  const speed = row.text("speed").toLowerCase();
  if (speed === "fast") modifiers.speed = "fast";
  else if (speed !== "" && speed !== "standard") {
    notes.add(`Speed "${speed}" is priced at standard rates.`);
  }

  const geo = row.text("inference_geo").toLowerCase();
  if (geo === "us") modifiers.inferenceGeo = "us";
  else if (geo !== "" && geo !== "global" && geo !== "not_available") {
    notes.add(`Inference region "${geo}" is priced at global rates.`);
  }

  const type = row.text("usage_type").toLowerCase();
  if (type.includes("batch")) modifiers.batch = true;
  else if (type !== "" && type !== "standard" && type !== "message" && type !== "messages") {
    notes.add(`Usage type "${type}" is priced at standard rates.`);
  }

  // `≤ 200k` or `200k - 1M`. Anything starting at 200k is the long tier.
  const context = row.text("context_window").toLowerCase().replace(/\s+/g, "");
  const longContext = /^200k?[-–]/.test(context);
  if (context !== "" && !longContext && !/^(≤|<=|<)?200k?$/.test(context)) {
    notes.add(`Context window "${row.text("context_window")}" is priced at standard rates.`);
  }

  return { modifiers, longContext };
}

/** Any of these means the file has usage columns, not just time buckets. */
const OPENAI_USAGE_SIGNS = ["model", "input_tokens", "output_tokens", "num_model_requests", "input_uncached_tokens"];

/**
 * OpenAI's activity export: time buckets (a day each, or a minute in a
 * single-day export) with usage columns only when there was usage. Token
 * counts are written as decimals; keys and projects are ids only.
 */
function readOpenAi(
  rows: readonly Row[],
  has: (column: string) => boolean,
  acc: RowAccumulator,
  notes: Notes,
  days: Set<string>,
): void {
  const hasUsage = OPENAI_USAGE_SIGNS.some(has);
  if (hasUsage) {
    const missing = ["model", "output_tokens"].filter((c) => !has(c));
    if (!has("input_uncached_tokens") && !has("input_tokens")) missing.push("input_tokens");
    if (missing.length > 0) throw missingColumns("openai", missing);
  }

  for (const row of rows) {
    const day = bucketDay(row);
    days.add(day);
    if (!hasUsage) continue;

    const model = row.text("model");
    const cached = row.count("input_cached_tokens");
    let input: number;
    if (row.has("input_uncached_tokens") && row.text("input_uncached_tokens") !== "") {
      input = row.count("input_uncached_tokens");
    } else {
      input = row.count("input_tokens") - cached;
      if (input < 0) {
        throw new UsageFileError(
          "bad-value",
          `Row ${row.number}: more cached input tokens than input tokens, which cannot be right.`,
          { row: row.number },
        );
      }
    }
    // Assumed to be part of the uncached input, as cached reads are part of
    // the total. If a row says otherwise they are taken as separate.
    const cacheWrite = row.count("input_cache_write_tokens");
    const usage: TokenUsage = {
      inputTokens: cacheWrite <= input ? input - cacheWrite : input,
      outputTokens: row.count("output_tokens"),
      cacheWrite5mTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      cacheReadTokens: cached,
    };
    const requests = row.count("num_model_requests");
    if (model !== "" && OTHER_PROVIDER_MODEL.openai.test(model)) {
      throw wrongModel("openai", model, row);
    }
    // A bucket with nothing in it: a quiet minute or day.
    if (isEmpty(usage) && requests === 0) continue;

    if (MEDIA_COLUMNS.some((c) => row.count(c) > 0)) {
      notes.add("Audio and image tokens are priced at text rates.");
    }
    const tier = row.text("service_tier").toLowerCase();
    if (tier !== "" && !["default", "auto", "standard"].includes(tier)) {
      notes.add(`Service tier "${tier}" is priced at standard rates.`);
    }
    const batch = /^(true|1|yes)$/i.test(row.text("batch"));
    const source = sourceOf(row.text("api_key_id"), row.text("project_id"), "project");
    const variant = { modifiers: batch ? { batch: true } : {} };
    acc.add(day, model || "unknown", source, usage, requests, variant);
  }
}

const MEDIA_COLUMNS = ["input_audio_tokens", "output_audio_tokens", "input_image_tokens", "output_image_tokens"];

/** The UTC day a bucket starts in, from `start_time` (Unix seconds) or `start_time_iso`. */
function bucketDay(row: Row): string {
  const seconds = row.text("start_time");
  if (/^\d{9,11}(\.0+)?$/.test(seconds)) return utcDay(Number(seconds) * 1000);
  const iso = row.text("start_time_iso") || seconds;
  if (iso === "") {
    throw new UsageFileError("bad-value", `Row ${row.number}: the bucket has no start time.`, {
      row: row.number,
    });
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(iso) && !Number.isNaN(Date.parse(iso))) return utcDay(iso);
  return dayOf(iso, row, "start_time");
}

function missingColumns(provider: Provider, missing: string[]): UsageFileError {
  return new UsageFileError(
    "missing-columns",
    `This does not look like a ${NAMES[provider]} usage export: it has no ${missing.join(", ")} ` +
      `column${missing.length === 1 ? "" : "s"}.`,
    { missing },
  );
}

function wrongModel(provider: "anthropic" | "openai", model: string, row: Row): UsageFileError {
  const other = provider === "anthropic" ? "OpenAI" : "Claude";
  return new UsageFileError(
    "wrong-provider",
    `Row ${row.number} uses ${model.slice(0, 60)}, which is a ${other} model. ` +
      `Upload this file under ${other}.`,
    { row: row.number },
  );
}

// -------------------------------------------------------------------- entry

/**
 * Read a provider's usage export into import rows.
 *
 * A file with no usage in it (OpenAI writes empty day buckets; Claude writes
 * just the header) is not an error: it returns no rows and, where the buckets
 * say, the days it covers, so those days can be cleared.
 */
export function parseUsageFile(provider: Provider, text: string): UsageFileResult {
  if (provider !== "anthropic" && provider !== "openai") {
    throw new UsageFileError(
      "wrong-provider",
      `Usage files can be read for Claude and OpenAI, not ${NAMES[provider]}.`,
    );
  }
  const shorter = "Export a shorter date range and upload each part.";
  if (text.length > MAX_FILE_CHARS) {
    throw new UsageFileError("too-large", `This file is larger than 32 MB. ${shorter}`);
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") throw new UsageFileError("empty", "This file is empty.");
  // A spreadsheet, a PDF or a sign-in page saved by mistake.
  if (body.includes("\u0000") || /^(PK\u0003\u0004|%PDF|\s*<)/.test(body)) {
    throw new UsageFileError(
      "not-csv",
      "This is not a CSV file. Download the usage export as CSV and upload that.",
    );
  }

  const records = parseCsv(body, detectDelimiter(body), MAX_DATA_ROWS + 1);
  if (records.length > MAX_DATA_ROWS + 1) {
    const limit = MAX_DATA_ROWS.toLocaleString("en-US");
    throw new UsageFileError("too-large", `This file has more than ${limit} rows. ${shorter}`);
  }
  const header = records[0]!.map(normaliseHeader);
  if (header.length < 2) {
    throw new UsageFileError("not-csv", "This file has only one column, so it is not a usage export.");
  }
  // The first column of a name wins, should a file ever repeat one.
  const columns = new Map<string, number>();
  header.forEach((name, index) => {
    if (name !== "" && !columns.has(name)) columns.set(name, index);
  });
  const has = (column: string): boolean => columns.has(column);

  const format = detect(has);
  if (format === "claude-cost" || format === "openai-cost") {
    const which = format === "claude-cost" ? "Claude" : "OpenAI";
    const wanted =
      format === "claude-cost"
        ? "the token usage export (Claude Console → Usage → Export, a file named claude_api_tokens_…)"
        : "the activity export (OpenAI Platform → Usage → Export, a file named completions_usage_…)";
    throw new UsageFileError(
      "cost-file",
      `This is the ${which} cost export, which shows spend but not the tokens behind it. ` +
        `Upload ${wanted} instead.`,
    );
  }
  if (format === undefined) {
    throw missingColumns(provider, provider === "anthropic" ? ["usage_date_utc"] : ["start_time"]);
  }
  const fileProvider = format === "claude-usage" ? "anthropic" : "openai";
  if (fileProvider !== provider) {
    throw new UsageFileError(
      "wrong-provider",
      `This is ${NAMES[fileProvider]}'s usage export, not ${NAMES[provider]}'s. ` +
        `Upload it under ${NAMES[fileProvider]}.`,
    );
  }

  const rows = records.slice(1).map((cells, index) => new Row(index + 2, cells, columns));
  const acc = new RowAccumulator();
  const notes = new Notes();
  const days = new Set<string>();
  if (format === "claude-usage") {
    const missing = CLAUDE_REQUIRED.filter((c) => !has(c));
    if (missing.length > 0) throw missingColumns("anthropic", missing);
    readClaude(rows, acc, notes, days);
  } else {
    readOpenAi(rows, has, acc, notes, days);
  }

  const result = acc.finish(provider);
  const sorted = [...days].sort();
  return {
    ...result,
    fromDay: sorted[0] ?? null,
    toDay: sorted.at(-1) ?? null,
    warnings: [...notes.list, ...acc.warnings],
  };
}
