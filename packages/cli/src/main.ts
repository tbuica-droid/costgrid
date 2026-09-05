#!/usr/bin/env node
import { toUsdString, usd } from "@costgrid/core";
import { Analytics, CostGridRepository, openDatabase, trailingWindow } from "@costgrid/db";
import { formatReport } from "./report.js";

const USAGE = `costgrid — LLM inference cost governance

Usage:
  costgrid init [name]                    Create the local tenant and a first API key
  costgrid key create <agent-name>        Mint an API key (shown once)
  costgrid key revoke <key-id>            Revoke a key
  costgrid report [--days N]              Spend report for the last N days (default 30)
  costgrid policy list                    Show configured policies
  costgrid policy budget <scope> <usd> [--window day|month] [--action monitor|warn|block]
  costgrid policy allow <model...>        Restrict the tenant to these models
  costgrid policy disable <policy-id>

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

function main(): void {
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

    case "report": {
      requireTenant();
      const days = Number(flag(argv, "days") ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        fail(`--days must be an integer 1..3650, got ${days}`);
      }
      console.log(formatReport(analytics, tenantId, trailingWindow(days), days));
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
              ? `budget $${toUsdString(p.rule.limit, 2)}/${p.rule.window}`
              : p.rule.kind === "max-output-tokens"
                ? `max_tokens <= ${p.rule.limit}`
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

        const id = repository.createPolicy(tenantId, {
          name: `${window}ly budget`,
          scope,
          rule: { kind: "budget", window, limit: usd(amount) },
          action: parseAction(flag(argv, "action")),
          enabled: true,
        });
        console.log(`Created policy ${id}.`);
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

main();
