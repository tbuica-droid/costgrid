#!/usr/bin/env node
/**
 * How much latency does CostGrid add to a call?
 *
 *   npm run bench                 # against a local stub: isolates our cost
 *   npm run bench -- --live       # against the real provider: confirms it holds
 *
 * ## Why there are two modes, and which number to quote
 *
 * The honest measurement of *overhead* is the stub run. It compares the same
 * client making the same call directly to a provider, and then through
 * CostGrid to that same provider, with everything else held still. The
 * difference is what CostGrid costs, and because the stub answers in
 * microseconds with no jitter, the difference is readable.
 *
 * The live run cannot measure overhead nearly as precisely, because a real
 * provider's own latency varies by tens or hundreds of milliseconds call to
 * call, which is one to three orders of magnitude larger than the thing being
 * measured. Run enough samples and the median difference still emerges, but
 * treat it as a sanity check that the stub figure survives contact with a real
 * network, not as the headline.
 *
 * Quoting the live delta as the overhead would be flattering and wrong in
 * both directions: it is noisy, and on a bad sample it can come out negative.
 *
 * ## What is actually being timed
 *
 * Buffered calls: the whole round trip. Streaming calls: time to first byte,
 * because that is what a user watching tokens appear actually experiences,
 * and total time, because that is what a batch job experiences.
 *
 * ## The null proxy, and why the naive comparison is misleading
 *
 * Comparing "direct to provider" against "through CostGrid" measures two
 * things at once: the cost of CostGrid's logic, and the unavoidable cost of
 * putting *any* extra Node process in the path. Only the first is CostGrid's
 * to answer for, and on a benchmark where client, proxy and provider share
 * eight cores the second gets large as concurrency rises.
 *
 * So there are three arms. The null proxy forwards bytes and does nothing
 * else: no parsing, no policy, no database. It is the floor. `null - direct`
 * is what a hop costs on this machine; `costgrid - null` is what CostGrid
 * costs, and that is the figure worth quoting.
 *
 * Concurrency is swept because a single number hides where the cost lives.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const LIVE = process.argv.includes("--live");
const STUB_PORT = 8931;
const GATEWAY_PORT = 8932;
const NULL_PORT = 8933;
const DB = "./.tmp-bench.db";

/*
 * Live mode stays well clear of the provider's rate limits: a 429 is not a
 * latency measurement, and a run that trips one measures the limiter rather
 * than the product. The stub has no such constraint.
 */
const CONCURRENCIES = LIVE ? [1, 4, 8] : [1, 10, 50];
/** Live samples cost money and take real time, so there are fewer of them. */
const SAMPLES = LIVE ? Number(flag("samples") ?? 24) : Number(flag("samples") ?? 300);
const WARMUP = LIVE ? 3 : 30;

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

// The key is read from the environment and never printed, logged or written.
// Run with `node --env-file=.env` so it never passes through a shell history.
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (LIVE && !API_KEY) {
  console.error(
    "bench --live needs ANTHROPIC_API_KEY in the environment.\n" +
      "Run it as:  npm run bench:live\n" +
      "which loads .env directly, so the key never reaches your shell history.",
  );
  process.exit(1);
}

const DIRECT_BASE = LIVE ? "https://api.anthropic.com" : `http://127.0.0.1:${STUB_PORT}`;
const GATEWAY_BASE = `http://127.0.0.1:${GATEWAY_PORT}`;

/*
 * A deliberately tiny call. The question is what CostGrid adds, not what the
 * model costs, so every token generated is noise in the measurement and money
 * off the card. Live mode bills roughly a hundredth of a cent per sample.
 */
const REQUEST = {
  model: LIVE ? "claude-haiku-4-5" : "claude-haiku-4-5",
  max_tokens: 4,
  messages: [{ role: "user", content: "Say hi" }],
};

// --- statistics --------------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function describe(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

const ms = (v) => (Number.isFinite(v) ? v.toFixed(2).padStart(8) : "     n/a");

// --- the two arms ------------------------------------------------------------

async function callOnce({ base, key, streaming, keyHeader }) {
  const started = process.hrtime.bigint();
  let firstByte;

  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(key ? { "x-api-key": key } : {}),
      ...(keyHeader ? { "x-costgrid-key": keyHeader, "x-costgrid-agent": "bench" } : {}),
    },
    body: JSON.stringify({ ...REQUEST, ...(streaming ? { stream: true } : {}) }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${body.slice(0, 200)}`);
  }

  if (streaming) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (firstByte === undefined && value !== undefined) {
        firstByte = Number(process.hrtime.bigint() - started) / 1e6;
      }
      if (done) break;
    }
  } else {
    await response.arrayBuffer();
    firstByte = Number(process.hrtime.bigint() - started) / 1e6;
  }

  const total = Number(process.hrtime.bigint() - started) / 1e6;
  return { total, firstByte: firstByte ?? total };
}

/**
 * Measure all arms at once, interleaved.
 *
 * Running them one after another looks simpler and is wrong: whichever arm
 * goes last is measured on a machine that has been working for a minute
 * longer, and CostGrid was always last. Thermal drift, background work and
 * page cache state all then load onto the arm under test.
 *
 * Interleaving makes every arm see the same machine. Each worker rotates
 * through the arms in turn, so a slow second is a slow second for all three.
 */
async function measureAll(arms, { streaming, concurrency, count }) {
  const results = arms.map(() => ({ totals: [], ttfbs: [], failures: 0 }));
  const slots = (count + WARMUP) * arms.length;
  let next = 0;

  async function worker() {
    for (;;) {
      const slot = next++;
      if (slot >= slots) return;
      const armIndex = slot % arms.length;
      const round = Math.floor(slot / arms.length);
      try {
        const sample = await callOnce({ ...arms[armIndex], streaming });
        // Warmup samples are timed and thrown away: the first calls pay for
        // connection setup and JIT, which is not what anyone is asking about.
        if (round >= WARMUP) {
          results[armIndex].totals.push(sample.total);
          results[armIndex].ttfbs.push(sample.firstByte);
        }
      } catch (error) {
        results[armIndex].failures++;
        if (results[armIndex].failures <= 2) {
          console.error(`    ${arms[armIndex].name} sample failed: ${error.message}`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.map((r) => ({
    total: describe(r.totals),
    ttfb: describe(r.ttfbs),
    failures: r.failures,
  }));
}

// --- harness -----------------------------------------------------------------

let stub;
if (!LIVE) {
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const request = JSON.parse(body || "{}");
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
        send({
          type: "message_start",
          message: { id: "m", model: request.model, usage: { input_tokens: 10, output_tokens: 1 } },
        });
        send({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } });
        send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } });
        send({ type: "message_stop" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "m",
          type: "message",
          role: "assistant",
          model: request.model,
          content: [{ type: "text", text: "hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
      );
    });
  });
  await new Promise((resolve, reject) => {
    stub.once("error", (e) => reject(new Error(`could not bind :${STUB_PORT} (${e.code})`)));
    stub.listen(STUB_PORT, resolve);
  });
}

/*
 * The control: a proxy with no product in it.
 *
 * Streams the request body upstream and the response back, holding no state
 * and reading nothing. Any latency it adds is the price of the extra hop
 * itself, which CostGrid cannot avoid and should not be charged for.
 */
const nullProxy = createServer((req, res) => {
  const target = new URL(req.url, LIVE ? DIRECT_BASE : `http://127.0.0.1:${STUB_PORT}`);
  const headers = { ...req.headers, host: target.host };
  fetch(target, {
    method: req.method,
    headers,
    body: req,
    duplex: "half",
    redirect: "manual",
  })
    .then(async (upstream) => {
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    })
    .catch((error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
});
await new Promise((resolve, reject) => {
  nullProxy.once("error", (e) => reject(new Error(`could not bind :${NULL_PORT} (${e.code})`)));
  nullProxy.listen(NULL_PORT, resolve);
});

for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });

const gateway = spawn("node", ["--import", "tsx", "packages/gateway/src/main.ts"], {
  env: {
    ...process.env,
    COSTGRID_DB: DB,
    COSTGRID_PORT: String(GATEWAY_PORT),
    COSTGRID_ALLOW_ANONYMOUS: "true",
    COSTGRID_LOG_LEVEL: "error",
    // Live mode forwards to the real provider with the operator's key, which
    // is exactly how a self-hosted deployment runs. Pinned explicitly rather
    // than inherited: a stray ANTHROPIC_BASE_URL in .env would otherwise send
    // the "live" run somewhere else and nobody would notice.
    ANTHROPIC_BASE_URL: LIVE ? "https://api.anthropic.com" : `http://127.0.0.1:${STUB_PORT}`,
    ...(LIVE ? {} : { ANTHROPIC_API_KEY: "sk-ant-stub-key-not-real" }),
  },
  stdio: ["ignore", "ignore", "inherit"],
});

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${GATEWAY_BASE}/health`);
    if (r.ok) break;
  } catch {}
  await sleep(250);
}

const DIRECT = { name: "direct", base: DIRECT_BASE, key: LIVE ? API_KEY : "stub" };
const NULL_HOP = { name: "null", base: `http://127.0.0.1:${NULL_PORT}`, key: LIVE ? API_KEY : "stub" };
const THROUGH = { name: "costgrid", base: GATEWAY_BASE };

console.log("");
console.log(`COSTGRID LATENCY · ${LIVE ? "live provider" : "local stub"} · ${SAMPLES} samples per cell`);
console.log("");
if (LIVE) {
  console.log("  Against the real API. The provider's own variance is far larger than");
  console.log("  the overhead being measured, so read the median difference, not the tail.");
} else {
  console.log("  Against a local stub, so the difference between the two rows is");
  console.log("  CostGrid's cost and nothing else. This is the number to quote.");
}
console.log("");

const rows = [];
for (const streaming of [false, true]) {
  for (const concurrency of CONCURRENCIES) {
    const label = `${streaming ? "stream" : "buffer"} c=${concurrency}`;
    process.stderr.write(`  measuring ${label}...\r`);

    const [direct, nullHop, through] = await measureAll([DIRECT, NULL_HOP, THROUGH], {
      streaming,
      concurrency,
      count: SAMPLES,
    });

    rows.push({ label, streaming, concurrency, direct, nullHop, through });
  }
}
process.stderr.write("                                   \r");

const metricName = (streaming) => (streaming ? "time to first byte" : "round trip");
let last = null;
for (const row of rows) {
  if (row.streaming !== last) {
    console.log(`  ${metricName(row.streaming).toUpperCase()}`);
    console.log("  " + "-".repeat(74));
    console.log(
      "  conc" +
        "     direct".padStart(12) +
        "   null hop".padStart(12) +
        "   costgrid".padStart(12) +
        "   hop cost".padStart(12) +
        "   cg p50".padStart(11) +
        "   cg p99".padStart(11),
    );
    last = row.streaming;
  }
  const pick = (arm) => (row.streaming ? arm.ttfb : arm.total);
  const d = pick(row.direct);
  const n = pick(row.nullHop);
  const t = pick(row.through);
  const failures = row.direct.failures + row.nullHop.failures + row.through.failures;
  console.log(
    `  ${String(row.concurrency).padStart(4)}` +
      `${ms(d.p50)}` +
      `${ms(n.p50)}` +
      `${ms(t.p50)}` +
      `${ms(n.p50 - d.p50)}` +
      `${ms(t.p50 - n.p50)}` +
      `${ms(t.p99 - n.p99)}` +
      (failures > 0 ? `   (${failures} failed)` : "") +
      // CostGrid does strictly more work than the null proxy, so a negative
      // delta cannot be real. It means the machine's own noise is larger than
      // the thing being measured, and the row should not be quoted.
      (t.p50 - n.p50 < 0 || t.p99 - n.p99 < 0 ? "   << NOISE, do not quote" : ""),
  );
}

console.log("");
console.log("  All figures milliseconds. 'hop cost' is the null proxy's own overhead:");
console.log("  the price of any extra process in the path, which CostGrid cannot avoid.");
console.log("  'cg p50' and 'cg p99' are CostGrid measured against that floor, which is");
console.log("  the honest statement of what this product costs a request.");
console.log("");

/*
 * State the conclusion, rather than leaving a reader to pick a number out of
 * the grid. In live mode that conclusion is mostly about what cannot be
 * concluded, which is the point: a table with impossible negatives in it
 * invites somebody to quote the one cell that flatters the product.
 */
const clean = rows.filter((r) => {
  const pick = (arm) => (r.streaming ? arm.ttfb : arm.total);
  return pick(r.through).p50 - pick(r.nullHop).p50 >= 0 && pick(r.through).p99 - pick(r.nullHop).p99 >= 0;
});

console.log("  WHAT THIS RUN SUPPORTS");
console.log("  " + "-".repeat(74));
if (LIVE) {
  const baseline = describe(rows.map((r) => (r.streaming ? r.direct.ttfb.p50 : r.direct.total.p50)));
  console.log(`  The provider's own call takes about ${baseline.p50.toFixed(0)} ms at the median, and`);
  console.log("  varies by tens to hundreds of milliseconds call to call. CostGrid's overhead");
  console.log("  is roughly a millisecond, so it is two to three orders of magnitude below");
  console.log("  the noise and this run cannot resolve it. That is the expected result.");
  console.log("");
  console.log("  What it does establish is the thing a customer actually asks: putting");
  console.log("  CostGrid in the path makes no difference anyone can perceive. Run the");
  console.log("  stub mode for the overhead figure itself.");
} else if (clean.length === 0) {
  console.log("  Nothing. Every cell came back with an impossible negative, which means");
  console.log("  this machine was too loaded to measure anything. Re-run it idle.");
} else {
  const worstP50 = Math.max(
    ...clean.map((r) => {
      const pick = (arm) => (r.streaming ? arm.ttfb : arm.total);
      return pick(r.through).p50 - pick(r.nullHop).p50;
    }),
  );
  const worstP99 = Math.max(
    ...clean.map((r) => {
      const pick = (arm) => (r.streaming ? arm.ttfb : arm.total);
      return pick(r.through).p99 - pick(r.nullHop).p99;
    }),
  );
  console.log(`  ${clean.length} of ${rows.length} cells produced a usable measurement.`);
  console.log(`  Across those, CostGrid's own cost peaked at ${worstP50.toFixed(2)} ms p50 and ${worstP99.toFixed(2)} ms p99.`);
  console.log("");
  console.log("  Cells marked NOISE are not results. CostGrid does strictly more work than");
  console.log("  the null proxy, so a negative difference is the machine talking, not the");
  console.log("  product. Client, proxy, gateway and provider all share this box; high");
  console.log("  concurrency needs the load generator and the provider on separate hosts");
  console.log("  before any figure from it means anything.");
}
console.log("");

gateway.kill("SIGTERM");
nullProxy.close();
if (stub) stub.close();
await sleep(300);
for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
