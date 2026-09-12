#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { findModelPrice, toUsdString, usd } from "@costgrid/core";
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
  costgrid policy route <scope> <to-model> [--from a,b] [--action monitor|warn|block]
                                          Send matching traffic to a cheaper model.
                                          Start with --action monitor: it is a dry
                                          run that records the saving without
                                          changing a single request.
  costgrid policy disable <policy-id>
  costgrid backup <path>                  Consistent copy of the database (use this, not cp)

Scope is "tenant", "dept:<name>" or "agent:<id>".

Environment:
  COSTGRID_DB        Database path (default ./costgrid.db)
  COSTGRID_TENANT    Tenant id (default "local")
`;

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
          const detail =
            p.rule.kind === "budget"
              ? `budget $${toUsdString(p.rule.limit, 2)}/${p.rule.window}` +
                (p.rule.fallbackModel ? ` -> ${p.rule.fallbackModel}` : "")
              : p.rule.kind === "max-output-tokens"
                ? `max_tokens <= ${p.rule.limit}`
                : p.rule.kind === "route"
                  ? `route ${p.rule.from?.length ? p.rule.from.join(",") : "*"} -> ${p.rule.toModel}` +
                    (p.action === "monitor" ? "  (dry run)" : "")
                  : `${p.rule.kind} [${p.rule.models.join(", ")}]`;
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
