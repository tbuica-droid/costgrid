#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import {
  deriveRate,
  discountPercent,
  findModelPrice,
  type Policy,
  rateFromDiscountPercent,
  toUsdString,
  usd,
} from "@costgrid/core";
import {
  Analytics,
  backupDatabase,
  buildStatement,
  CostGridRepository,
  ImportsRepository,
  monthOf,
  openDatabase,
  statementToCsv,
  trailingWindow,
} from "@costgrid/db";
import { formatPreflight, preflight } from "@costgrid/gateway";
import { formatReport } from "./report.js";
import { formatStatement } from "./statement.js";

const USAGE = `costgrid — LLM inference cost governance

Usage:
  costgrid init [name]                    Create the local tenant and a first API key
  costgrid key create <agent-name>        Mint an API key (shown once)
  costgrid key revoke <key-id>            Revoke a key
  costgrid report [--days N]              Spend report for the last N days (default 30)
  costgrid statement [--month YYYY-MM] [--format text|csv|json] [--out FILE]
                                          Monthly statement for finance: spend by team,
                                          movement against last month, budget status and
                                          what routing saved. Defaults to this month.
  costgrid policy list                    Show configured policies
  costgrid policy budget <scope> <usd> [--window day|month] [--action monitor|warn|block]
                              [--fallback <model>]
                                          With --fallback, over-budget traffic is
                                          downgraded to that model instead of being
                                          refused, so a cap stops breaking production.
  costgrid policy allow <model...>        Restrict the tenant to these models
  costgrid policy run-budget <scope> <usd> [--fallback <model>] [--action ...]
                                          Ceiling on a single run, not a window.
  costgrid policy run-steps <scope> <n>   Stop a run after n calls (loop guard)
  costgrid policy run-depth <scope> <n>   Limit delegation hops from the root run
  costgrid policy route <scope> <to-model> [--from a,b] [--action monitor|warn|block]
                                          Send matching traffic to a cheaper model.
                                          Start with --action monitor: it is a dry
                                          run that records the saving without
                                          changing a single request.
  costgrid policy disable <policy-id>
  costgrid runs [--days N] [--limit N]    Most expensive runs in the window
  costgrid run <run-id>                   Every call in one run, in order
  costgrid rates                          Show negotiated rates in force
  costgrid rates set <provider> --discount <pct>
                                          Apply a known enterprise discount
  costgrid rates derive <provider> --invoiced <usd> [--days N]
                                          Derive the rate from an actual invoice total
  costgrid rates clear <provider>
  costgrid preflight <provider> [--model ID]
                                          One real call to a provider, reporting exactly
                                          which stage fails. Use it for bedrock and vertex,
                                          which were built without an account to test on.
  costgrid backup <path>                  Consistent copy of the database (use this, not cp)

Scope is "tenant", "dept:<name>" or "agent:<id>".

Environment:
  COSTGRID_DB        Database path (default ./costgrid.db)
  COSTGRID_TENANT    Tenant id (default "local")
`;


/**
 * One line describing a rule, for `policy list`.
 *
 * A switch rather than a ternary chain because it is exhaustive: the next rule
 * kind added to the union fails this function at compile time instead of
 * reaching a customer's terminal as `[object Object]`.
 */
function describeRule(rule: Policy["rule"], action: string): string {
  switch (rule.kind) {
    case "budget":
      return (
        `budget $${toUsdString(rule.limit, 2)}/${rule.window}` +
        (rule.fallbackModel ? ` -> ${rule.fallbackModel}` : "")
      );
    case "run-budget":
      return (
        `budget $${toUsdString(rule.limit, 2)}/run` +
        (rule.fallbackModel ? ` -> ${rule.fallbackModel}` : "")
      );
    case "run-steps":
      return `max ${rule.limit} call(s) per run`;
    case "run-depth":
      return `max ${rule.limit} delegation hop(s)`;
    case "max-output-tokens":
      return `max_tokens <= ${rule.limit}`;
    case "route":
      return (
        `route ${rule.from?.length ? rule.from.join(",") : "*"} -> ${rule.toModel}` +
        (action === "monitor" ? "  (dry run)" : "")
      );
    case "model-allowlist":
    case "model-denylist":
      return `${rule.kind} [${rule.models.join(", ")}]`;
  }
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined) fail(`--${name} needs a value`);
  return value;
}

function parseScope(raw: string) {
  if (raw === "tenant") return { kind: "tenant" } as const;
  if (raw.startsWith("dept:")) return { kind: "department", department: raw.slice(5) } as const;
  if (raw.startsWith("agent:")) return { kind: "agent", agentId: raw.slice(6) } as const;
  return fail(`unrecognised scope ${JSON.stringify(raw)} — use tenant, dept:<name> or agent:<id>`);
}

function parseAction(raw: string | undefined) {
  const value = raw ?? "block";
  if (value !== "monitor" && value !== "warn" && value !== "block") {
    return fail(`--action must be monitor, warn or block, got ${value}`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  const dbPath = process.env["COSTGRID_DB"]?.trim() || "./costgrid.db";
  const tenantId = process.env["COSTGRID_TENANT"]?.trim() || "local";
  const db = openDatabase({ path: dbPath });
  const repository = new CostGridRepository(db);
  const analytics = new Analytics(db);

  const requireTenant = (): void => {
    if (!repository.getTenant(tenantId)) {
      fail(`tenant "${tenantId}" does not exist — run "costgrid init" first`);
    }
  };

  switch (command) {
    case "init": {
      if (repository.getTenant(tenantId)) {
        console.log(`Tenant "${tenantId}" already exists.`);
      } else {
        repository.createTenant(argv[1] ?? "Local", tenantId);
        console.log(`Created tenant "${tenantId}".`);
      }
      const key = repository.createApiKey(tenantId, "default");
      console.log(`\nAPI key (shown once, store it now):\n\n  ${key.plaintext}\n`);
      console.log("Use it as the x-costgrid-key header, or set COSTGRID_ALLOW_ANONYMOUS=true");
      console.log("to meter without one while you are the only caller.");
      break;
    }

    case "key": {
      requireTenant();
      const sub = argv[1];
      if (sub === "create") {
        const name = argv[2] ?? fail("key create needs an agent name");
        const key = repository.createApiKey(tenantId, name);
        console.log(`API key for "${name}" (shown once):\n\n  ${key.plaintext}\n`);
      } else if (sub === "revoke") {
        repository.revokeApiKey(argv[2] ?? fail("key revoke needs a key id"));
        console.log("Revoked.");
      } else {
        fail(`unknown key subcommand ${JSON.stringify(sub)}`);
      }
      break;
    }

    case "backup": {
      const destination = argv[1] ?? fail("backup needs a destination path");
      // `cp` on a WAL database loses whatever is still in the -wal sidecar,
      // which is always the most recent calls. This checkpoints properly.
      await backupDatabase(db, destination);
      console.log(`Wrote a consistent copy to ${destination}.`);
      break;
    }

    case "report": {
      requireTenant();
      const days = Number(flag(argv, "days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        fail(`--days must be an integer 1..3650, got ${days}`);
      }
      console.log(formatReport(analytics, tenantId, trailingWindow(days), days));
      break;
    }

    case "statement": {
      requireTenant();
      const month = flag(argv, "month") ?? monthOf();
      const format = flag(argv, "format") ?? "text";
      if (format !== "text" && format !== "csv" && format !== "json") {
        fail(`--format must be text, csv or json, got ${format}`);
      }

      let statement;
      try {
        statement = buildStatement({
          analytics,
          repository,
          imports: new ImportsRepository(db),
          tenantId,
          month,
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }

      const rendered =
        format === "csv"
          ? statementToCsv(statement)
          : format === "json"
            ? // Money is bigint nanodollars, which JSON cannot hold. Serialising
              // it as a decimal string keeps the exact value; a float would not.
              JSON.stringify(statement, (_key, value) =>
                typeof value === "bigint" ? toUsdString(value, 9) : value,
              )
            : formatStatement(statement);

      const out = flag(argv, "out");
      if (out === undefined) {
        console.log(rendered);
      } else {
        writeFileSync(out, rendered.endsWith("\n") ? rendered : `${rendered}\n`);
        console.log(`Wrote ${format} statement for ${statement.month} to ${out}.`);
      }
      break;
    }

    case "runs": {
      requireTenant();
      const days = Number(flag(argv, "days") ?? 7);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        fail(`--days must be an integer 1..3650, got ${days}`);
      }
      const limit = Number(flag(argv, "limit") ?? 20);
      const range = trailingWindow(days);
      const runs = analytics.runsSummary(tenantId, range, limit);
      const coverage = analytics.runCoverage(tenantId, range);

      if (runs.length === 0) {
        console.log(`\nNo multi-step runs recorded in the last ${days} day(s).`);
        if (coverage.total > 0) {
          // The most common cause by far, and invisible without saying it.
          console.log(
            "Callers are not sending the x-costgrid-run header, so every call is\n" +
              "its own run and run-scoped policies cannot fire. See docs/QUICKSTART.md.",
          );
        }
        break;
      }

      console.log(
        `\n  Runs — last ${days} day(s) · ${coverage.declared} of ${coverage.total} ` +
          `call(s) carry a run id\n`,
      );
      console.log(
        `  ${"RUN".padEnd(26)}${"AGENT".padEnd(18)}${"COST".padStart(10)}` +
          `${"CALLS".padStart(7)}${"DEPTH".padStart(7)}  STARTED`,
      );
      for (const r of runs) {
        const started = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 16);
        console.log(
          `  ${r.runId.slice(0, 24).padEnd(26)}${r.agentId.slice(0, 16).padEnd(18)}` +
            `${("$" + toUsdString(r.cost, 2)).padStart(10)}${String(r.calls).padStart(7)}` +
            `${String(r.depth).padStart(7)}  ${started}` +
            (r.blockedCalls > 0 ? `  (${r.blockedCalls} blocked)` : ""),
        );
      }
      console.log("");
      break;
    }

    case "run": {
      requireTenant();
      const runId = argv[1] ?? fail("run needs a run id");
      const steps = analytics.runDetail(tenantId, runId);
      if (steps.length === 0) fail(`no calls recorded for run ${runId}`);

      const total = steps.reduce((sum, s2) => sum + s2.cost, 0n);
      console.log(`\n  Run ${runId}`);
      console.log(`  ${"─".repeat(68)}`);
      console.log(
        `  ${steps.length} call(s) · $${toUsdString(total, 2)} · depth ${steps[0]!.depth}` +
          (steps[0]!.parentRunId ? ` · delegated by ${steps[0]!.parentRunId}` : ""),
      );
      console.log("");
      for (const step of steps) {
        const served =
          step.requestedModel && step.requestedModel !== step.model
            ? `${step.requestedModel} -> ${step.model}`
            : step.model;
        console.log(
          `  ${String(step.step).padStart(3)}.  ${served.padEnd(34)}` +
            `${("$" + toUsdString(step.cost, 6)).padStart(12)}  ${step.outcome}` +
            (step.stopReason ? `  [${step.stopReason}]` : ""),
        );
        if (step.errorMessage) console.log(`       ${step.errorMessage}`);
      }
      console.log("");
      break;
    }

    case "preflight": {
      const provider = argv[1] ?? fail("preflight needs a provider");
      const envVar = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        bedrock: "AWS_BEDROCK_CREDENTIAL",
        vertex: "GOOGLE_SERVICE_ACCOUNT_JSON",
      }[provider];
      if (envVar === undefined) fail(`unknown provider ${JSON.stringify(provider)}`);

      const credential = process.env[envVar];
      if (credential === undefined || credential.trim() === "") {
        fail(`${envVar} is not set, so there is no credential to test with.`);
      }

      const defaultModel = {
        anthropic: "claude-haiku-4-5",
        openai: "gpt-5-nano",
        bedrock: "anthropic.claude-haiku-4-5-v1:0",
        vertex: "claude-haiku-4-5@20251001",
      }[provider]!;

      const result = await preflight({
        provider,
        credential,
        model: flag(argv, "model") ?? defaultModel,
        ...(flag(argv, "base-url") !== undefined ? { baseUrl: flag(argv, "base-url") } : {}),
      });
      console.log(formatPreflight(result));
      if (!result.ok) process.exitCode = 1;
      break;
    }

    case "rates": {
      requireTenant();
      const sub = argv[1] ?? "list";

      if (sub === "list") {
        const rates = repository.listRateOverrides(tenantId);
        if (rates.length === 0) {
          console.log("\nNo negotiated rates. Every call is priced at catalog list.");
          console.log("If you buy off list, your figures here will read high — see");
          console.log("`costgrid rates derive --help` or docs/QUICKSTART.md.\n");
          break;
        }
        console.log("");
        for (const rate of rates) {
          const pct = discountPercent(rate);
          console.log(
            `  ${rate.provider.padEnd(12)} ${pct.toFixed(2)}% off list  [${rate.source}]`,
          );
          if (rate.evidence) {
            const span = `${new Date(rate.evidence.from).toISOString().slice(0, 10)} to ${new Date(
              rate.evidence.to,
            )
              .toISOString()
              .slice(0, 10)}`;
            console.log(
              `               invoiced $${toUsdString(rate.evidence.reported, 2)} against ` +
                `$${toUsdString(rate.evidence.catalog, 2)} at list, ${span}`,
            );
          }
        }
        console.log("");
        break;
      }

      if (sub === "set") {
        const provider = argv[2] ?? fail("rates set needs a provider");
        const discount = Number(flag(argv, "discount") ?? fail("rates set needs --discount <pct>"));
        let rate;
        try {
          rate = rateFromDiscountPercent(provider, discount);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        repository.setRateOverride(tenantId, rate);
        console.log(`${provider} is now priced at ${discount}% off list.`);
        console.log("Calls recorded from here on use this rate; history keeps the price it was");
        console.log("recorded at, and every row keeps its catalog price alongside.");
        break;
      }

      if (sub === "derive") {
        const provider = argv[2] ?? fail("rates derive needs a provider");
        const invoiced = flag(argv, "invoiced") ?? fail("rates derive needs --invoiced <usd>");
        const days = Number(flag(argv, "days") ?? 30);
        if (!Number.isInteger(days) || days < 1 || days > 3650) {
          fail(`--days must be an integer 1..3650, got ${days}`);
        }

        const range = trailingWindow(days);
        const basis = analytics.catalogTotal(tenantId, provider, range);
        if (basis.total <= 0n) {
          fail(
            `no ${provider} traffic priced in the last ${days} day(s), so there is nothing ` +
              "to compare an invoice against. Meter some calls or import history first.",
          );
        }

        const reported = usd(invoiced);
        const rate = deriveRate(provider, reported, basis.total);
        if (!rate) {
          fail(
            `$${toUsdString(reported, 2)} against $${toUsdString(basis.total, 2)} at list is ` +
              "not a plausible rate. Check the window matches the invoice period, and that " +
              "the invoice covers only this provider.",
          );
        }

        repository.setRateOverride(tenantId, {
          ...rate,
          evidence: { from: range.from, to: range.to, reported, catalog: basis.total },
        });

        const pct = discountPercent(rate);
        console.log(
          `\nDerived ${pct.toFixed(2)}% off list for ${provider}: $${toUsdString(reported, 2)} ` +
            `invoiced against $${toUsdString(basis.total, 2)} at catalog prices,`,
        );
        console.log(
          `over ${days} day(s) — ${basis.meteredCalls} metered call(s) and ` +
            `${basis.importedRows} imported row(s).\n`,
        );
        if (basis.unpriced > 0) {
          // Unpriced traffic is missing from the denominator, so the derived
          // discount reads deeper than it is.
          console.log(
            `Warning: ${basis.unpriced} item(s) could not be priced and are absent from the\n` +
              "comparison, so this rate understates what you pay. Fix the catalog first.\n",
          );
        }
        break;
      }

      if (sub === "clear") {
        const provider = argv[2] ?? fail("rates clear needs a provider");
        console.log(
          repository.clearRateOverride(tenantId, provider)
            ? `Cleared. ${provider} is priced at catalog list again.`
            : `No rate was set for ${provider}.`,
        );
        break;
      }

      fail(`unknown rates subcommand ${JSON.stringify(sub)}`);
      break;
    }

    case "policy": {
      requireTenant();
      const sub = argv[1];

      if (sub === "list") {
        const policies = repository.listPolicies(tenantId);
        if (policies.length === 0) {
          console.log("No policies configured. Everything is allowed and metered.");
          break;
        }
        for (const p of policies) {
          const scope =
            p.scope.kind === "tenant"
              ? "tenant"
              : p.scope.kind === "agent"
                ? `agent:${p.scope.agentId}`
                : `dept:${p.scope.department}`;
          const detail = describeRule(p.rule, p.action);
          console.log(
            `${p.enabled ? "on " : "off"}  ${p.action.padEnd(7)}  ${scope.padEnd(24)}  ${detail}`,
          );
          console.log(`     ${p.id}  ${p.name}`);
        }
        break;
      }

      if (sub === "budget") {
        const scope = parseScope(argv[2] ?? fail("policy budget needs a scope"));
        const amount = argv[3] ?? fail("policy budget needs a USD amount");
        const window = flag(argv, "window") ?? "month";
        if (window !== "day" && window !== "month") fail(`--window must be day or month`);

        // Reject an unpriceable fallback here rather than at request time. A
        // typo would otherwise sit dormant until the budget fired, and then
        // the rule would quietly revert to refusing calls.
        const fallbackModel = flag(argv, "fallback");
        if (fallbackModel !== undefined && !findModelPrice(fallbackModel)) {
          fail(`--fallback model ${fallbackModel} is not in the price catalog`);
        }

        const action = parseAction(flag(argv, "action"));
        const id = repository.createPolicy(tenantId, {
          name: fallbackModel ? `${window}ly budget, fallback ${fallbackModel}` : `${window}ly budget`,
          scope,
          rule: {
            kind: "budget",
            window,
            limit: usd(amount),
            ...(fallbackModel ? { fallbackModel } : {}),
          },
          action,
          enabled: true,
        });
        console.log(`Created policy ${id}.`);
        if (fallbackModel !== undefined) {
          console.log(
            action === "monitor"
              ? `Dry run: over-budget calls are recorded as if downgraded to ${fallbackModel},`
              : `Over-budget calls will answer on ${fallbackModel} instead of failing.`,
          );
          if (action === "monitor") console.log("but nothing is rewritten yet.");
          if (action === "block") {
            console.log(
              `They only fail if the downgrade cannot be made — traffic already on ` +
                `${fallbackModel}, or on another provider.`,
            );
          }
        }
        break;
      }

      if (sub === "run-budget" || sub === "run-steps" || sub === "run-depth") {
        const scope = parseScope(argv[2] ?? fail(`policy ${sub} needs a scope`));
        const raw = argv[3] ?? fail(`policy ${sub} needs a limit`);

        let rule;
        if (sub === "run-budget") {
          const fallbackModel = flag(argv, "fallback");
          if (fallbackModel !== undefined && !findModelPrice(fallbackModel)) {
            fail(`--fallback model ${fallbackModel} is not in the price catalog`);
          }
          rule = {
            kind: "run-budget" as const,
            limit: usd(raw),
            ...(fallbackModel ? { fallbackModel } : {}),
          };
        } else {
          const limit = Number(raw);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
            fail(`policy ${sub} limit must be an integer 1..100000, got ${raw}`);
          }
          rule =
            sub === "run-steps"
              ? { kind: "run-steps" as const, limit }
              : { kind: "run-depth" as const, limit };
        }

        const id = repository.createPolicy(tenantId, {
          name: sub === "run-budget" ? `run budget $${raw}` : `${sub} ${raw}`,
          scope,
          rule,
          action: parseAction(flag(argv, "action")),
          enabled: true,
        });
        console.log(`Created policy ${id}.`);
        // Worth saying every time: the rule is inert until callers propagate
        // the header, and nothing else in the product tells them so.
        console.log(
          "Run rules apply only to calls carrying the x-costgrid-run header.\n" +
            "Traffic without it is metered as a run of one and is unaffected.",
        );
        break;
      }

      if (sub === "allow") {
        const models = argv.slice(2).filter((a) => !a.startsWith("--"));
        if (models.length === 0) fail("policy allow needs at least one model id");
        const id = repository.createPolicy(tenantId, {
          name: "model allowlist",
          scope: { kind: "tenant" },
          rule: { kind: "model-allowlist", models },
          action: parseAction(flag(argv, "action")),
          enabled: true,
        });
        console.log(`Created policy ${id}.`);
        break;
      }

      if (sub === "route") {
        const scope = parseScope(argv[2] ?? fail("policy route needs a scope"));
        const toModel = argv[3] ?? fail("policy route needs a target model");
        const from = flag(argv, "from")
          ?.split(",")
          .map((m) => m.trim())
          .filter((m) => m !== "");

        // Default to a dry run. Rewriting a customer's request is the one
        // action here that can quietly degrade their product, so switching it
        // on has to be a deliberate second step.
        const action = parseAction(flag(argv, "action") ?? "monitor");
        const id = repository.createPolicy(tenantId, {
          name: `route to ${toModel}`,
          scope,
          rule: { kind: "route", toModel, ...(from && from.length > 0 ? { from } : {}) },
          action,
          enabled: true,
        });

        console.log(`Created policy ${id}.`);
        if (action === "monitor") {
          console.log("Dry run: nothing is rewritten. Run a report to see the estimated saving,");
          console.log("then re-create with --action warn to start routing for real.");
        }
        break;
      }

      if (sub === "disable") {
        repository.setPolicyEnabled(argv[2] ?? fail("policy disable needs a policy id"), false);
        console.log("Disabled.");
        break;
      }

      fail(`unknown policy subcommand ${JSON.stringify(sub)}`);
      break;
    }

    default:
      fail(`unknown command ${JSON.stringify(command)} — run "costgrid --help"`);
  }

  db.close();
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
