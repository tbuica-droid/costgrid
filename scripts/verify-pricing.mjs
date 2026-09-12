#!/usr/bin/env node
/**
 * Verify the price catalog against Anthropic's published pricing page.
 *
 * A hand-maintained price table is a claim that decays silently: nothing
 * breaks when a rate changes, the bills are just wrong. This fetches the live
 * page, parses the model pricing table, and diffs it against the catalog.
 *
 * Exit codes:
 *   0  catalog matches the published table
 *   1  a discrepancy was found, or the catalog is stale
 *   2  could not fetch or parse the page (verification inconclusive)
 *
 * Run it in CI on a schedule. Exit 2 must not be treated as a pass — an
 * unreachable source means the catalog is unverified, not correct.
 */
import {
  CATALOG_SOURCE,
  CATALOG_STALE_AFTER_DAYS,
  CATALOG_VERIFIED_AT,
  catalogAgeDays,
  listModelPrices,
} from "../packages/core/dist/index.js";

const FETCH_TIMEOUT_MS = 30_000;

/** Display names in the published table, mapped to our catalog ids. */
function idForDisplayName(name) {
  const cleaned = name
    .replace(/\[.*?\]\(.*?\)/g, "") // strip markdown links like "(retired…)"
    .replace(/\(.*?\)/g, "")
    .trim();

  const match = /^Claude (Fable|Mythos|Opus|Sonnet|Haiku) ([\d.]+)$/.exec(cleaned);
  if (!match) return undefined;

  const [, family, version] = match;
  return `claude-${family.toLowerCase()}-${version.replace(/\./g, "-")}`;
}

function parseMoney(cell) {
  const match = /\$\s*([\d.]+)\s*\/\s*MTok/.exec(cell);
  return match ? Number(match[1]) : undefined;
}

/** Extract the "Model pricing" table rows from the page markdown. */
function parsePricingTable(markdown) {
  const rows = new Map();

  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;

    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    // Model | base input | 5m write | 1h write | cache hit | output
    if (cells.length < 6) continue;

    const id = idForDisplayName(cells[0]);
    if (!id) continue;

    const input = parseMoney(cells[1]);
    const write5m = parseMoney(cells[2]);
    const write1h = parseMoney(cells[3]);
    const cacheRead = parseMoney(cells[4]);
    const output = parseMoney(cells[5]);

    // The batch-pricing table has the same shape but only two money columns;
    // requiring all five keeps us on the model-pricing table.
    if ([input, write5m, write1h, cacheRead, output].some((v) => v === undefined)) continue;

    rows.set(id, { input, write5m, write1h, cacheRead, output });
  }

  return rows;
}

/** Our stored nanodollars-per-token back to $/MTok, for comparison. */
const toMTok = (nanoPerToken) => Number(nanoPerToken * 1_000_000n) / 1e9;

async function main() {
  const age = catalogAgeDays();
  console.log(`CostGrid price catalog — verified ${CATALOG_VERIFIED_AT} (${age} days ago)`);
  console.log(`Source: ${CATALOG_SOURCE}\n`);

  let markdown;
  try {
    const response = await fetch(CATALOG_SOURCE, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/html,text/markdown" },
    });
    if (!response.ok) {
      console.error(`Could not fetch pricing page: HTTP ${response.status}`);
      process.exit(2);
    }
    markdown = await response.text();
  } catch (error) {
    console.error(`Could not fetch pricing page: ${error.message}`);
    console.error("Verification is INCONCLUSIVE — the catalog is unverified, not confirmed.");
    process.exit(2);
  }

  const published = parsePricingTable(markdown);
  if (published.size === 0) {
    console.error("Parsed zero rows from the pricing page — its format likely changed.");
    console.error("Verification is INCONCLUSIVE. Update the parser in this script.");
    process.exit(2);
  }

  const problems = [];
  const checked = [];

  for (const model of listModelPrices()) {
    const row = published.get(model.id);
    if (!row) {
      problems.push(`${model.id}: in our catalog but NOT on the published page (retired?)`);
      continue;
    }

    const compare = [
      ["input", toMTok(model.input), row.input],
      ["output", toMTok(model.output), row.output],
      ["cache write 5m", toMTok(model.cacheWrite5m), row.write5m],
      ["cache write 1h", toMTok(model.cacheWrite1h), row.write1h],
      ["cache read", toMTok(model.cacheRead), row.cacheRead],
    ];

    let ok = true;
    for (const [label, ours, theirs] of compare) {
      // Exact comparison at cent resolution; these are published list prices,
      // not measurements, so any difference is a real discrepancy.
      if (Math.abs(ours - theirs) > 1e-9) {
        problems.push(
          `${model.id}: ${label} is $${ours.toFixed(4)}/MTok, published $${theirs.toFixed(4)}/MTok`,
        );
        ok = false;
      }
    }
    if (ok) checked.push(model.id);
  }

  for (const id of published.keys()) {
    if (!listModelPrices().some((m) => m.id === id)) {
      problems.push(`${id}: published but MISSING from our catalog — its calls record as unpriced`);
    }
  }

  console.log(`${checked.length} model(s) match the published table.`);

  if (problems.length > 0) {
    console.error(`\n${problems.length} discrepancy(ies):\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\nUpdate packages/core/src/pricing.ts, then bump CATALOG_VERIFIED_AT.`);
    process.exit(1);
  }

  if (age > CATALOG_STALE_AFTER_DAYS) {
    console.error(
      `\nPrices match, but CATALOG_VERIFIED_AT is ${age} days old ` +
        `(stale after ${CATALOG_STALE_AFTER_DAYS}). Bump it to today's date.`,
    );
    process.exit(1);
  }

  console.log("\nCatalog is accurate and fresh.");
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
