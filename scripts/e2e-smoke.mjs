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

const cli = (args, extraEnv = {}) =>
  new Promise((resolve) => {
    const p = spawn("node", ["--import", "tsx", "packages/cli/src/main.ts", ...args], {
      env: { ...process.env, COSTGRID_DB: DB, COSTGRID_TENANT: "local", ...extraEnv },
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

console.log("\n6. soft fallback: over budget downgrades instead of refusing");
// A cap this small is already blown by the calls above, so the next Opus call
// is over budget by definition.
const capOut = await cli(["policy", "budget", "tenant", "0.000001", "--fallback", "claude-haiku-4-5", "--action", "block"]);
const capId = /Created policy (\S+)\./.exec(capOut)?.[1];
res = await call({ model: "claude-opus-5", max_tokens: 100 }, { "x-costgrid-agent": "fallback-test" });
check("over-budget call still answered", res.status, 200);
check("answered on the cheap model", (await res.json()).model, "claude-haiku-4-5");
check("caller told it was downgraded", res.headers.get("x-costgrid-fallback"), "claude-opus-5->claude-haiku-4-5");

// Nothing cheaper left to give: the cap is a cap again.
res = await call({ model: "claude-haiku-4-5", max_tokens: 100 }, { "x-costgrid-agent": "fallback-test" });
check("no downgrade left, so it blocks", res.status, 403);

await cli(["policy", "disable", capId]);

console.log("\n7. enforcement: block the expensive model");
await cli(["policy", "allow", "claude-haiku-4-5", "--action", "block"]);
res = await call({ model: "claude-opus-5", max_tokens: 100 }, { "x-costgrid-agent": "docs-writer" });
check("blocked status", res.status, 403);
check("block reason", (await res.json()).error.type, "costgrid_policy_blocked");

res = await call({ model: "claude-haiku-4-5", max_tokens: 100 }, { "x-costgrid-agent": "ticket-classifier" });
check("allowlisted model still passes", res.status, 200);

console.log("\n8. runs: a loop that stops itself");
await cli(["policy", "run-steps", "tenant", "3"]);
const runStatuses = [];
for (let i = 0; i < 5; i += 1) {
  const r = await call(
    { model: "claude-haiku-4-5", max_tokens: 100 },
    { "x-costgrid-agent": "loop-agent", "x-costgrid-run": "smoke-loop" },
  );
  runStatuses.push(r.status);
  await r.text();
}
check("loop ran three times then stopped", runStatuses.join(","), "200,200,200,403,403");

// Traffic without the header is untouched — the rule cannot see it.
res = await call({ model: "claude-haiku-4-5", max_tokens: 100 }, { "x-costgrid-agent": "no-run" });
check("unlabelled traffic is unaffected", res.status, 200);

const runsOut = await cli(["runs", "--days", "1"]);
check("run is listed", /smoke-loop/.test(runsOut), true);
const runOut = await cli(["run", "smoke-loop"]);
check("run detail numbers its steps", /  1\./.test(runOut) && /  4\./.test(runOut), true);
check("blocked step is shown in the run", /blocked/.test(runOut), true);

console.log("\n9. topology: tools and delegation, read off the wire");
res = await call(
  {
    model: "claude-haiku-4-5",
    max_tokens: 100,
    tools: [{ name: "search_kb" }, { name: "refund_customer" }],
  },
  { "x-costgrid-agent": "topo-parent", "x-costgrid-run": "topo-root" },
);
check("tool-declaring call succeeds", res.status, 200);
await res.text();

res = await call(
  { model: "claude-haiku-4-5", max_tokens: 100, tools: [{ name: "query_db" }] },
  {
    "x-costgrid-agent": "topo-child",
    "x-costgrid-run": "topo-sub",
    "x-costgrid-parent-run": "topo-root",
  },
);
await res.text();

const topo = await (await fetch(`${base}/api/topology?days=1`)).json();
const edge = (kind, from, to) =>
  topo.edges.some((e) => e.kind === kind && e.from === from && e.to === to);
check("agent -> model edge extracted", edge("invokes", "topo-parent", "claude-haiku-4-5"), true);
check("granted tool extracted", edge("grants", "topo-parent", "refund_customer"), true);
check("delegation extracted", edge("delegates", "topo-parent", "topo-child"), true);
check("no delegation loop reported", topo.cycles.length, 0);

console.log("\n10. tool boundary: the delegate is stopped too");
/*
 * Section 9 left topo-parent delegating to topo-child, so the chain this rule
 * has to follow is real metered traffic rather than a fixture.
 */
await cli(["policy", "deny-tool", "agent:topo-parent", "refund_customer"]);

res = await call(
  { model: "claude-haiku-4-5", max_tokens: 100, tools: [{ name: "refund_customer" }] },
  { "x-costgrid-agent": "topo-parent" },
);
check("denied tool is refused at the source", res.status, 403);
const denied = await res.json();
check("reason names the tool", /refund_customer/.test(denied.error.message), true);

// The same request from the delegate, which no rule names directly.
res = await call(
  { model: "claude-haiku-4-5", max_tokens: 100, tools: [{ name: "refund_customer" }] },
  {
    "x-costgrid-agent": "topo-child",
    "x-costgrid-run": "topo-sub-2",
    "x-costgrid-parent-run": "topo-root",
  },
);
check("delegate cannot reach it either", res.status, 403);
check("reason names who delegated", /topo-parent/.test((await res.json()).error.message), true);

// Everything else the same agents do is untouched.
res = await call(
  { model: "claude-haiku-4-5", max_tokens: 100, tools: [{ name: "search_kb" }] },
  { "x-costgrid-agent": "topo-parent" },
);
check("other tools are unaffected", res.status, 200);
await res.text();

const boundaryOut = await cli(["policy", "list"]);
check("boundary is listed", /may not use \[refund_customer\]/.test(boundaryOut), true);

console.log("\n10b. advise: proposes from this run's own traffic");
/*
 * The smoke run makes a couple of dozen calls, which is far below every
 * threshold in the advisor. That is the assertion: it says so plainly rather
 * than inventing a finding to look useful on thin data.
 */
const adviceOut = await cli(["advise", "--days", "1"]);
check("advise runs", /COSTGRID ADVISE/.test(adviceOut), true);
check(
  "thin data produces no invented findings",
  /Nothing to propose/.test(adviceOut),
  true,
);

const adviceJson = JSON.parse(await cli(["advise", "--days", "1", "--format", "json"]));
check("json form is an array", Array.isArray(adviceJson), true);

console.log("\n10c. the analyst: what leaves the network, and what it is checked against");

/*
 * The model here is a local stand-in, like the provider stub. It proves the
 * request shape, the confidentiality boundary and the grounding check. It
 * proves nothing about how a real model answers.
 */
const fakeModel = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const sent = JSON.parse(body).messages.at(-1).content;
    const real = (sent.match(/\$[\d,]+\.\d{2}/g) ?? [])[0] ?? "$0.00";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: `You spent ${real}. I also invented $4,242.00.` } }],
      }),
    );
  });
});
await new Promise((resolve) => fakeModel.listen(8124, resolve));

const shown = await cli(["ask", "--show-data", "--days", "1"]);
check("show-data prints the briefing", /Window: the last 1 days/.test(shown), true);
// The confidentiality promise, checked rather than asserted.
check("no prompt text in the briefing", /Reply with the single word/.test(shown), false);
check("no tool arguments in the briefing", /cus_|amount_usd/.test(shown), false);

const answered = await cli(["ask", "why did spend move", "--days", "1"], {
  COSTGRID_ANALYST_DEMO_KEY: "smoke-demo-key",
  COSTGRID_ANALYST_MODEL: "stand-in",
  COSTGRID_ANALYST_BASE_URL: "http://127.0.0.1:8124",
});
check("answers the question", /You spent \$/.test(answered), true);
check("catches the invented figure", /\$4,242\.00 does not appear/.test(answered), true);
check("says it is on the trial key", /trial key/.test(answered), true);
check("says it cannot act", /cannot change a rule/.test(answered), true);
fakeModel.close();

console.log("\n10d. outcomes: did the money buy anything");
res = await call({ run_id: "smoke-loop", success: true, label: "smoke" }, {}, "/v1/costgrid/outcome");
check("outcome accepted", res.status, 202);
await res.text();

res = await call({ success: true }, {}, "/v1/costgrid/outcome");
check("outcome without a run id is refused", res.status, 400);
await res.text();

const withOutcome = await cli(["report", "--days", "1"]);
check("report shows whether it worked", /Did it work\?/.test(withOutcome), true);
check("report names the denominator", /You reported on/.test(withOutcome), true);

console.log("\n10e. autopilot: bounded, recorded, reversible");
check("off until switched on", /Autopilot is off/.test(await cli(["autopilot", "status"])), true);
await cli(["autopilot", "monitor"]);
const piloted = await cli(["autopilot", "run", "--days", "1"]);
check("it says what it looked at", /proposal\(s\) at level monitor/.test(piloted), true);
// The boundary, asserted against live output rather than only in unit tests.
check(
  "it refuses anything that could refuse a call",
  /only creates routing rules|Changed nothing/.test(piloted),
  true,
);
const undone = await cli(["autopilot", "undo"]);
check("undo is one command", /Switched off|Nothing to undo/.test(undone), true);
await cli(["autopilot", "off"]);

console.log("\n11. negotiated rate: figures reconcile with an invoice");
await cli(["rates", "set", "anthropic", "--discount", "18"]);
res = await call({ model: "claude-haiku-4-5", max_tokens: 100 }, { "x-costgrid-agent": "enterprise" });
check("discounted call still succeeds", res.status, 200);
await res.text();

const ratesOut = await cli(["rates"]);
check("rate is listed", /anthropic\s+18\.00% off list/.test(ratesOut), true);

const discounted = await cli(["statement", "--format", "json"]);
const parsedStatement = JSON.parse(discounted);
check("statement declares the rate", parsedStatement.rates[0].discountPercent, 18);

// The catalog price survives on the row, so the discount stays provable.
const listVsPaid = await cli(["report", "--days", "1"]);
check("report still renders under a rate", /Total spend/.test(listVsPaid), true);
await cli(["rates", "clear", "anthropic"]);

console.log("\n12. monthly statement, in every format it exports");
const statementText = await cli(["statement"]);
check("statement names this month", /CostGrid statement · /.test(statementText), true);
check("statement is marked month to date", /Month to date/.test(statementText), true);

const statementCsv = await cli(["statement", "--format", "csv"]);
const csvLines = statementCsv.trim().split("\n");
check("csv starts with the month header", csvLines[0].startsWith("CostGrid statement,"), true);
check("csv carries the line-item header", csvLines.includes(
  "section,item,calls,cost_usd,share_pct,previous_cost_usd,change_pct",
), true);
check("csv totals the department rows to the total", (() => {
  const cell = (line) => Number(line.split(",")[3]);
  const total = cell(csvLines.find((l) => l.startsWith("total,")));
  const departments = csvLines
    .filter((l) => l.startsWith("department,"))
    .reduce((sum, l) => sum + cell(l), 0);
  return Math.abs(total - departments) < 1e-6;
})(), true);

const statementJson = JSON.parse(await cli(["statement", "--format", "json"]));
// Money must survive as an exact decimal string, never a float.
check("json money is a string", typeof statementJson.total, "string");

console.log("\n13. CLI report\n");
console.log(await cli(["report", "--days", "1"]));

gateway.kill("SIGTERM");
stub.close();
await sleep(300);
for (const suffix of ["", "-wal", "-shm"]) {
  rmSync(`${DB}${suffix}`, { force: true });
}
console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
process.exit(process.exitCode ?? 0);
