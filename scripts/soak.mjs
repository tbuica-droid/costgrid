#!/usr/bin/env node
/**
 * Soak test: hours of steady traffic, looking for what a quick test misses.
 *
 *   npm run soak                          # 10 minutes, 16 callers, 50 calls/s
 *   npm run soak -- --minutes 1440 --concurrency 32 --rate 80
 *
 * Runs the compiled gateway (npm run build first) against a stub provider on
 * this machine, with its own throwaway database, and sends a mix of buffered
 * and streamed calls from several agents. Every 30 seconds it reads the
 * gateway's own /metrics for memory, and at the end it reports:
 *
 *   - calls answered and failed, and latency percentiles through CostGrid
 *   - resident memory and heap at the start (after warm-up) and the end
 *   - whether the heap kept growing across the second half of the run,
 *     which is what a leak looks like and a short test never shows
 *
 * The rate stays under the gateway's own limit (6,000 calls a minute on the
 * default plan): a soak is about hours of ordinary load, not overload. Calls
 * the limit still refuses are counted apart from failures.
 *
 * It fails (exit 1) when more than 0.1% of calls fail, or when the heap grew
 * by more than half between the end of warm-up and the end of the run. Both
 * thresholds are deliberately loose: this catches leaks and breakage, not a
 * few percent of noise. No network, no API key, no cost.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const MINUTES = arg("minutes", 10);
const CONCURRENCY = arg("concurrency", 16);
const RATE = arg("rate", 50);
const WARMUP_MS = Math.min(60_000, (MINUTES * 60_000) / 5);

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ------------------------------------------------------------ stub provider

const MESSAGE = {
  id: "msg_soak",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 150 },
};

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    ["message_start", { type: "message_start", message: { ...MESSAGE, content: [], usage: { input_tokens: 1200, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 150 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

const stubPort = await freePort();
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    if (parsed.stream) return sse(res);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...MESSAGE, model: parsed.model ?? MESSAGE.model }));
  });
});
await new Promise((resolve) => stub.listen(stubPort, "127.0.0.1", resolve));

// ------------------------------------------------------------------ gateway

const dir = mkdtempSync(join(tmpdir(), "costgrid-soak-"));
const port = await freePort();
const metricsToken = "soak-metrics-token-long-enough-to-pass";
const gateway = spawn("node", ["packages/gateway/dist/main.js"], {
  env: {
    ...process.env,
    COSTGRID_DB: join(dir, "soak.db"),
    COSTGRID_PORT: String(port),
    COSTGRID_ALLOW_ANONYMOUS: "true",
    ANTHROPIC_API_KEY: "sk-ant-soak-not-a-real-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubPort}`,
    COSTGRID_METRICS_TOKEN: metricsToken,
    COSTGRID_LOG_LEVEL: "error",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/ready`)).ok) break;
  } catch {}
  if (i > 100) throw new Error("the gateway did not become ready");
  await new Promise((r) => setTimeout(r, 100));
}

async function memory() {
  const text = await (await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } })).text();
  const read = (name) => Number(new RegExp(`^${name} (\\S+)$`, "m").exec(text)?.[1] ?? NaN);
  return { rss: read("costgrid_resident_memory_bytes"), heap: read("costgrid_heap_used_bytes") };
}

// --------------------------------------------------------------------- load

const latencies = [];
let ok = 0;
let failed = 0;
let limited = 0;
const end = Date.now() + MINUTES * 60_000;

async function caller(n) {
  // Each caller's share of the target rate.
  const gapMs = (1000 * CONCURRENCY) / RATE;
  for (let i = 0; Date.now() < end; i++) {
    const stream = i % 4 === 0;
    const started = performance.now();
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-costgrid-agent": `soak-${n % 8}`, "x-costgrid-run": `run-${n}-${Math.floor(i / 5)}` },
        body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 200, stream, messages: [{ role: "user", content: `job ${n}-${i}` }] }),
      });
      await res.arrayBuffer();
      if (res.ok) ok++;
      else if (res.status === 429) limited++;
      else failed++;
    } catch {
      failed++;
    }
    const took = performance.now() - started;
    latencies.push(took);
    if (latencies.length > 200_000) latencies.splice(0, 100_000);
    if (took < gapMs) await new Promise((r) => setTimeout(r, gapMs - took));
  }
}

const samples = [];
const sampler = setInterval(async () => {
  try {
    samples.push({ at: Date.now(), ...(await memory()) });
  } catch {}
}, 30_000);

console.log(`Soaking for ${MINUTES} min with ${CONCURRENCY} callers at about ${RATE} calls/s...`);
let warm;
setTimeout(async () => {
  warm = await memory().catch(() => undefined);
}, WARMUP_MS);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, n) => caller(n)));
clearInterval(sampler);
const final = await memory();

gateway.kill("SIGTERM");
stub.close();
await new Promise((r) => gateway.once("exit", r));
rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------------------------- report

const sorted = [...latencies].sort((a, b) => a - b);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]?.toFixed(1);
const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;
const total = ok + failed + limited;
const failRate = total === 0 ? 1 : failed / total;
const growth = warm ? final.heap / warm.heap - 1 : 0;

// Heap trend over the second half: the slope of a least-squares line, in MB per hour.
const half = samples.filter((s) => s.at >= samples[0]?.at + (samples.at(-1)?.at - samples[0]?.at) / 2);
let slope = 0;
if (half.length >= 3) {
  const xs = half.map((s) => (s.at - half[0].at) / 3_600_000);
  const ys = half.map((s) => s.heap / 1048576);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
}

console.log(
  `\nCalls: ${total} (${(total / (MINUTES * 60)).toFixed(0)}/s), failed ${failed} (${(failRate * 100).toFixed(3)}%), refused by the rate limit ${limited}`,
);
console.log(`Latency through CostGrid: p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms`);
console.log(`Memory after warm-up: rss ${warm ? mb(warm.rss) : "?"}, heap ${warm ? mb(warm.heap) : "?"}`);
console.log(`Memory at the end:    rss ${mb(final.rss)}, heap ${mb(final.heap)} (${(growth * 100).toFixed(0)}% heap change)`);
if (half.length >= 3) console.log(`Heap trend over the second half: ${slope.toFixed(1)} MB/hour`);

const problems = [];
if (failRate > 0.001) problems.push("more than 0.1% of calls failed");
if (growth > 0.5) problems.push("the heap grew by more than half after warm-up");
if (problems.length > 0) {
  console.log(`\nSOAK FAILED: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("\nSOAK PASSED");
