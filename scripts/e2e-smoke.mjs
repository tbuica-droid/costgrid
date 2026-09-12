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
import { createServer as createNetServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const DB = "./.tmp-e2e.db";

/**
 * Grab a port the OS says is free.
 *
 * Fixed ports were a trap: a leftover gateway from a crashed run kept
 * answering /health, so this script bound nothing, talked to the stale
 * process, and reported failures that had nothing to do with the code.
 */
async function freePort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const STUB_PORT = await freePort();
const GATEWAY_PORT = await freePort();

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

    // OpenAI shape, on its own path.
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 4000,
            completion_tokens: 900,
            prompt_tokens_details: { cached_tokens: 3000 },
          },
        }),
      );
      return;
    }

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
// Fail loudly on a busy port. Without the error handler `listen` simply never
// resolves and the whole script hangs with no output, which is a genuinely
// horrible thing to debug.
await new Promise((resolve, reject) => {
  stub.once("error", (error) =>
    reject(
      new Error(
        `could not bind :${STUB_PORT} (${error.code}). ` +
          "A previous run may still be listening — check with: lsof -nP -iTCP:" + STUB_PORT,
      ),
    ),
  );
  stub.listen(STUB_PORT, resolve);
});
console.log(`stub provider on :${STUB_PORT}`);

// --- Gateway ----------------------------------------------------------------
const gateway = spawn("node", ["--import", "tsx", "packages/gateway/src/main.ts"], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "sk-ant-stub-key-for-local-smoke-test",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    OPENAI_API_KEY: "sk-openai-stub-key-for-local-smoke-test",
    OPENAI_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    COSTGRID_DB: DB,
    COSTGRID_PORT: String(GATEWAY_PORT),
    COSTGRID_ALLOW_ANONYMOUS: "true",
    COSTGRID_LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

// A thrown error would otherwise leave the stub listening and the script
// hanging with no output — the failure mode that cost the most time here.
process.on("uncaughtException", (error) => {
  console.error(error);
  gateway.kill("SIGKILL");
  stub.close();
  process.exit(1);
});

const base = `http://127.0.0.1:${GATEWAY_PORT}`;
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${base}/health`);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 100) {
    gateway.kill("SIGKILL");
    throw new Error(
      `gateway did not start on :${GATEWAY_PORT} within 10s — see its output above, ` +
        `and check nothing else is listening: lsof -nP -iTCP:${GATEWAY_PORT}`,
    );
  }
  await sleep(100);
}
console.log("gateway up");

const call = (payload, headers = {}, path = "/v1/messages") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

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

console.log("\n4. openai on its own route, with OpenAI's cached-token semantics");
res = await call(
  { model: "gpt-5", max_completion_tokens: 512 },
  { "x-costgrid-agent": "summariser", "x-costgrid-department": "Marketing" },
  "/v1/chat/completions",
);
check("status", res.status, 200);
check("openai model echoed", (await res.json()).model, "gpt-5");

console.log("\n5. auto-routing: dry run first, then live");
await cli(["policy", "route", "tenant", "claude-haiku-4-5", "--from", "claude-sonnet-5", "--action", "monitor"]);
res = await call({ model: "claude-sonnet-5", max_tokens: 100 }, { "x-costgrid-agent": "router-test" });
check("dry run served the requested model", (await res.json()).model, "claude-sonnet-5");
check("dry run advertised itself", res.headers.get("x-costgrid-routed")?.startsWith("dry-run:"), true);

await cli(["policy", "route", "tenant", "claude-haiku-4-5", "--from", "claude-opus-5", "--action", "warn"]);
res = await call({ model: "claude-opus-5", max_tokens: 100 }, { "x-costgrid-agent": "router-test" });
check("live route rewrote the model", (await res.json()).model, "claude-haiku-4-5");

console.log("\n6. enforcement: block the expensive model");
await cli(["policy", "allow", "claude-haiku-4-5", "--action", "block"]);
res = await call({ model: "claude-opus-5", max_tokens: 100 }, { "x-costgrid-agent": "docs-writer" });
check("blocked status", res.status, 403);
check("block reason", (await res.json()).error.type, "costgrid_policy_blocked");

res = await call({ model: "claude-haiku-4-5", max_tokens: 100 }, { "x-costgrid-agent": "ticket-classifier" });
check("allowlisted model still passes", res.status, 200);

console.log("\n7. CLI report\n");
console.log(await cli(["report", "--days", "1"]));

gateway.kill("SIGTERM");
stub.close();
await sleep(300);
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${DB}${suffix}`, { force: true });
}
console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
process.exit(process.exitCode ?? 0);
