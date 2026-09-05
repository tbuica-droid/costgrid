/**
 * End-to-end smoke test against a stub provider.
 *
 * Boots a fake Anthropic endpoint, runs the real gateway process against it,
 * drives real HTTP traffic through it (buffered and streaming), and then reads
 * the database back through the real CLI. No network, no API key, no cost.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const DB = "./.tmp-e2e.db";
const STUB_PORT = 8799;
const GATEWAY_PORT = 8798;

for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${DB}${suffix}`, { force: true });
}

// --- Stub provider ----------------------------------------------------------
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const request = JSON.parse(body || "{}");
    const model = request.model ?? "claude-opus-5";

    if (request.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      send({
        type: "message_start",
        message: { id: "msg_stream", model, usage: { input_tokens: 3000, output_tokens: 1 } },
      });
      send({ type: "content_block_delta", delta: { type: "text_delta", text: "hello" } });
      send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1200 } });
      send({ type: "message_stop" });
      res.end();
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_buffered",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 2000,
          output_tokens: 800,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 5000,
        },
      }),
    );
  });
});
await new Promise((r) => stub.listen(STUB_PORT, r));
console.log(`stub provider on :${STUB_PORT}`);

// --- Gateway ----------------------------------------------------------------
const gateway = spawn("node", ["--import", "tsx", "packages/gateway/src/main.ts"], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "sk-ant-stub-key-for-local-smoke-test",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    COSTGRID_DB: DB,
    COSTGRID_PORT: String(GATEWAY_PORT),
    COSTGRID_ALLOW_ANONYMOUS: "true",
    COSTGRID_LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const base = `http://127.0.0.1:${GATEWAY_PORT}`;
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 100) throw new Error("gateway did not start");
  await sleep(100);
}
console.log("gateway up");

const call = (payload, headers = {}) =>
  fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
  if (!ok) process.exitCode = 1;
}

console.log("\n1. buffered call, cache read priced separately");
let res = await call(
  { model: "claude-opus-5", max_tokens: 1024 },
  { "x-costgrid-agent": "docs-writer", "x-costgrid-department": "Engineering" },
);
check("status", res.status, 200);
check("body model", (await res.json()).model, "claude-opus-5");

console.log("\n2. streaming call passes bytes through");
res = await call(
  { model: "claude-opus-5", max_tokens: 4096, stream: true },
  { "x-costgrid-agent": "chat-bot", "x-costgrid-department": "Support" },
);
const streamed = await res.text();
check("saw message_start", streamed.includes('"type":"message_start"'), true);
check("saw message_stop", streamed.includes('"type":"message_stop"'), true);

console.log("\n3. cheap model on a different agent");
await call(
  { model: "claude-haiku-4-5", max_tokens: 512 },
  { "x-costgrid-agent": "ticket-classifier", "x-costgrid-department": "Support" },
);

console.log("\n4. enforcement: block the expensive model");
const cli = (args) =>
  new Promise((resolve) => {
    const p = spawn("node", ["--import", "tsx", "packages/cli/src/main.ts", ...args], {
      env: { ...process.env, COSTGRID_DB: DB, COSTGRID_TENANT: "local" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", () => resolve(out));
  });

await cli(["policy", "allow", "claude-haiku-4-5", "--action", "block"]);
res = await call({ model: "claude-opus-5", max_tokens: 100 }, { "x-costgrid-agent": "docs-writer" });
check("blocked status", res.status, 403);
check("block reason", (await res.json()).error.type, "costgrid_policy_blocked");

res = await call({ model: "claude-haiku-4-5", max_tokens: 100 }, { "x-costgrid-agent": "ticket-classifier" });
check("allowlisted model still passes", res.status, 200);

console.log("\n5. CLI report\n");
console.log(await cli(["report", "--days", "1"]));

gateway.kill("SIGTERM");
stub.close();
await sleep(300);
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${DB}${suffix}`, { force: true });
}
console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
process.exit(process.exitCode ?? 0);
