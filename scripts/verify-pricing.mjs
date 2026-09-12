#!/usr/bin/env node
/**
 * Verify the price catalog against each provider's published pricing page.
 *
 * A hand-maintained price table is a claim that decays silently: nothing
 * breaks when a rate changes, the bills are just wrong. This fetches the live
 * pages, parses their model pricing tables, and diffs them against the catalog.
 *
 * Exit codes:
 *   0  catalog matches every published table
 *   1  a discrepancy was found, or the catalog is stale
 *   2  a page could not be fetched or parsed (verification inconclusive)
 *
 * Run it in CI on a schedule. Exit 2 must not be treated as a pass — an
 * unreachable source means the catalog is unverified, not correct.
 */
import {
  CATALOG_PROVENANCE,
  CATALOG_STALE_AFTER_DAYS,
  catalogAgeDays,
  findModelPrice,
  listModelPrices,
} from "../packages/core/dist/index.js";

const FETCH_TIMEOUT_MS = 30_000;

/** Our stored nanodollars-per-token back to $/MTok, for comparison. */
const toMTok = (nanoPerToken) => Number(nanoPerToken * 1_000_000n) / 1e9;

function parseMoney(cell) {
  const match = /\$\s*([\d.]+)/.exec(cell);
  return match ? Number(match[1]) : undefined;
}

function tableRows(markdown) {
  return markdown
    .split("\n")
    .filter((line) => line.trim().startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((c) => c.trim()));
}

/**
 * Narrow a page to one section.
 *
 * Both pricing pages carry several tables — batch, flex, fast, fine-tuning —
 * with the same column shape as the standard one. Parsing the whole document
 * lets a later table silently overwrite the rates we actually bill at, which
 * is how a verifier ends up confidently reporting the wrong discrepancy.
 */
function section(markdown, heading) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return undefined;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,4} /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// ---------------------------------------------------------------- Anthropic

function anthropicIdFor(name) {
  const cleaned = name
    .replace(/\[.*?\]\(.*?\)/g, "")
    .replace(/\(.*?\)/g, "")
    .trim();
  const match = /^Claude (Fable|Mythos|Opus|Sonnet|Haiku) ([\d.]+)$/.exec(cleaned);
  if (!match) return undefined;
  return `claude-${match[1].toLowerCase()}-${match[2].replace(/\./g, "-")}`;
}

/** Model | input | 5m write | 1h write | cache read | output */
function parseAnthropic(markdown) {
  const rows = new Map();
  for (const cells of tableRows(markdown)) {
    if (cells.length < 6) continue;
    const id = anthropicIdFor(cells[0]);
    if (!id) continue;

    const values = {
      input: parseMoney(cells[1]),
      cacheWrite5m: parseMoney(cells[2]),
      cacheWrite1h: parseMoney(cells[3]),
      cacheRead: parseMoney(cells[4]),
      output: parseMoney(cells[5]),
    };
    // The batch-pricing table has the same shape but fewer money columns;
    // requiring all five keeps us on the model-pricing table.
    if (Object.values(values).some((v) => v === undefined)) continue;
    rows.set(id, values);
  }
  return rows;
}

// ------------------------------------------------------------------- OpenAI

/** Model | short in | short cached | short write | short out | long… */
function parseOpenAi(fullMarkdown) {
  const markdown = section(fullMarkdown, "### Standard pricing data");
  if (markdown === undefined) return new Map();

  const rows = new Map();
  for (const cells of tableRows(markdown)) {
    if (cells.length < 5) continue;

    // Rows annotate context limits, e.g. "gpt-5.5 (<272K context length)".
    const id = cells[0].replace(/\(.*?\)/g, "").trim();
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(id)) continue;

    const input = parseMoney(cells[1]);
    const output = parseMoney(cells[4]);
    if (input === undefined || output === undefined) continue;

    rows.set(id, {
      input,
      // "-" means the model does not support caching; our catalog then prices
      // a cache read at the input rate, so that is what we compare against.
      cacheRead: parseMoney(cells[2]) ?? input,
      cacheWrite5m: parseMoney(cells[3]) ?? input,
      cacheWrite1h: parseMoney(cells[3]) ?? input,
      output,
    });
  }
  return rows;
}

const PARSERS = { anthropic: parseAnthropic, openai: parseOpenAi };

/** OpenAI serves markdown at the .md suffix; Anthropic's page is markdown already. */
function sourceUrls(provider, source) {
  return provider === "openai" ? [`${source}.md`, source] : [source];
}

async function fetchMarkdown(urls) {
  let lastError = "no url tried";
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "text/markdown,text/html" },
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${url}`;
        continue;
      }
      return await response.text();
    } catch (error) {
      lastError = `${error.message} (${url})`;
    }
  }
  throw new Error(lastError);
}

async function verifyProvider({ provider, source, verifiedAt }) {
  console.log(`\n── ${provider} ─ verified ${verifiedAt} ─ ${source}`);

  let markdown;
  try {
    markdown = await fetchMarkdown(sourceUrls(provider, source));
  } catch (error) {
    console.error(`  Could not fetch: ${error.message}`);
    return { inconclusive: true, problems: [] };
  }

  const published = PARSERS[provider](markdown);
  if (published.size === 0) {
    console.error("  Parsed zero rows — the page format likely changed. Update the parser.");
    return { inconclusive: true, problems: [] };
  }

  const problems = [];
  let matched = 0;

  for (const model of listModelPrices(provider)) {
    const row = published.get(model.id);
    if (!row) {
      problems.push(`${model.id}: in our catalog but NOT on the published page`);
      continue;
    }

    let ok = true;
    for (const [label, ours, theirs] of [
      ["input", toMTok(model.input), row.input],
      ["output", toMTok(model.output), row.output],
      ["cache write", toMTok(model.cacheWrite5m), row.cacheWrite5m],
      ["cache read", toMTok(model.cacheRead), row.cacheRead],
    ]) {
      if (Math.abs(ours - theirs) > 1e-9) {
        problems.push(
          `${model.id}: ${label} is $${ours.toFixed(4)}/MTok, published $${theirs.toFixed(4)}/MTok`,
        );
        ok = false;
      }
    }
    if (ok) matched += 1;
  }

  // A published id we do not list explicitly is still covered if it resolves
  // to a catalog entry at the same price — that is what the dated-snapshot
  // fallback is for. It is only a gap when nothing resolves, or when the
  // resolved entry charges something different.
  const explicit = new Set(listModelPrices(provider).map((m) => m.id));
  for (const [id, row] of published) {
    if (explicit.has(id)) continue;

    const resolved = findModelPrice(id);
    if (!resolved || resolved.provider !== provider) {
      problems.push(`${id}: published but MISSING from our catalog — its calls record as unpriced`);
      continue;
    }
    if (
      Math.abs(toMTok(resolved.input) - row.input) > 1e-9 ||
      Math.abs(toMTok(resolved.output) - row.output) > 1e-9
    ) {
      problems.push(
        `${id}: resolves to ${resolved.id} at $${toMTok(resolved.input)}/$${toMTok(resolved.output)}, ` +
          `but is published at $${row.input}/$${row.output} — it needs its own catalog row`,
      );
    }
  }

  const ours = listModelPrices(provider).length;
  console.log(
    `  ${matched}/${ours} catalogued model(s) match; ` +
      `${published.size} row(s) published, ${published.size - ours} covered by id resolution.`,
  );
  return { inconclusive: false, problems };
}

async function main() {
  const age = catalogAgeDays();
  console.log(`CostGrid price catalog — oldest verification ${age} day(s) ago`);

  let inconclusive = false;
  const problems = [];

  for (const entry of CATALOG_PROVENANCE) {
    const result = await verifyProvider(entry);
    inconclusive ||= result.inconclusive;
    problems.push(...result.problems);
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} discrepancy(ies):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nUpdate packages/core/src/pricing.ts, then bump the provider's verifiedAt.");
    process.exit(1);
  }

  if (inconclusive) {
    console.error("\nAt least one source was unreachable. Verification is INCONCLUSIVE.");
    process.exit(2);
  }

  if (age > CATALOG_STALE_AFTER_DAYS) {
    console.error(
      `\nPrices match, but the catalog is ${age} days old ` +
        `(stale after ${CATALOG_STALE_AFTER_DAYS}). Bump verifiedAt.`,
    );
    process.exit(1);
  }

  console.log("\nCatalog is accurate and fresh across all providers.");
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
