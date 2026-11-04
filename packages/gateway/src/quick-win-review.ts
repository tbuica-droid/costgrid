import {
  type AuditLog,
  CostGridRepository,
  type Db,
  QuickWins,
  type QuickWinMeasurement,
  RuleRegister,
  SYSTEM_ACTOR,
} from "@costgrid/db";
import type { Alerter } from "./alerts.js";
import type { ReadPool } from "./read-pool.js";

/**
 * Keep a quick win only where it pays.
 *
 * Every hour, each acting `lower-reasoning` or `add-cache` rule is measured
 * (`quick-wins.ts`). A rule whose measurement says it costs more, or that
 * fewer jobs finish under it, goes back to a dry run: the calls go out as the
 * caller sent them again, and the rule keeps recording what it would have
 * done, so the owner can see why and switch it on again.
 *
 * Cache writes bill at 1.25 times the input rate, so breakpoints on a prompt
 * that changes every call cost money. This is where that is caught.
 *
 * Only ever towards the caller's own request. It never switches a rule on.
 */

export interface QuickWinReviewDeps {
  readonly db: Db;
  readonly audit: AuditLog;
  readonly alerter?: Alerter | undefined;
  readonly reads?: ReadPool | undefined;
}

const WORSE: ReadonlySet<QuickWinMeasurement["verdict"]> = new Set([
  "more-errors",
  "more-expensive",
  "fewer-jobs-finished",
]);

function why(m: QuickWinMeasurement): string {
  if (m.verdict === "more-errors") {
    const pctOf = (r: number | null) => Math.round((r ?? 0) * 100);
    return `${m.after.errors} of the calls it changed failed (${pctOf(m.after.errorRate)}% against ${pctOf(m.before.errorRate)}% before)`;
  }
  if (m.verdict === "fewer-jobs-finished") {
    const before = m.jobs?.before.finishedShare ?? 0;
    const after = m.jobs?.after.finishedShare ?? 0;
    return `fewer jobs finished under it (${Math.round(after * 100)}% against ${Math.round(before * 100)}% before)`;
  }
  const change = m.jobs?.changePerFinishedJob ?? m.changePerCall ?? 0;
  const per = m.jobs?.changePerFinishedJob != null ? "per finished job" : "per call";
  return `it cost ${Math.round(change * 100)}% more ${per} than before`;
}

/** Tenants with at least one acting adjustment rule: the only ones with anything to review. */
function tenantsToReview(db: Db): string[] {
  // Read in plain SQL and filtered here, so the query stays portable to Postgres.
  const rows = db
    .prepare("SELECT tenant_id AS tenantId, rule_json AS rule FROM policies WHERE enabled = 1 AND action != 'monitor'")
    .all() as { tenantId: string; rule: string }[];
  const kinds = new Set(["lower-reasoning", "add-cache"]);
  return [
    ...new Set(rows.filter((r) => kinds.has((JSON.parse(r.rule) as { kind: string }).kind)).map((r) => r.tenantId)),
  ];
}

/**
 * Review every tenant. Returns the rules switched back, for the log.
 *
 * `errorsOnly` is the quick check run every few minutes: it skips the
 * cost-per-finished-job comparison, which reads every run, and acts only on a
 * rise in failed calls, so a change the provider rejects is undone within
 * minutes rather than at the next hourly review.
 */
export async function reviewQuickWins(
  deps: QuickWinReviewDeps,
  now = Date.now(),
  opts: { errorsOnly?: boolean } = {},
): Promise<string[]> {
  const { db, audit, alerter, reads } = deps;
  const repository = new CostGridRepository(db);
  const switched: string[] = [];

  for (const tenantId of tenantsToReview(db)) {
    const measurements = opts.errorsOnly
      ? new QuickWins(db).measure(
          tenantId,
          new RuleRegister(db, repository).entries(tenantId, { from: now - 30 * 86_400_000, to: now + 1 }),
          now,
        )
      : reads === undefined
        ? new QuickWins(db).measure(
            tenantId,
            new RuleRegister(db, repository).entries(tenantId, { from: now - 30 * 86_400_000, to: now + 1 }),
            now,
            { jobs: true },
          )
        : await reads.run("quickWins", tenantId, now);

    for (const m of measurements) {
      if (!m.enabled || m.action === "monitor" || !WORSE.has(m.verdict)) continue;
      if (opts.errorsOnly && m.verdict !== "more-errors") continue;
      // Re-read: the owner may have changed the rule while the measurement ran.
      const current = repository.listPolicies(tenantId).find((p) => p.id === m.policyId);
      if (current === undefined || !current.enabled || current.action === "monitor") continue;

      repository.setPolicyAction(m.policyId, "monitor", now);
      const reason = why(m);
      audit.record(
        tenantId,
        {
          actor: SYSTEM_ACTOR,
          action: "policy.quick-win-reverted",
          subject: m.policyId,
          detail: { name: m.policyName, kind: m.kind, verdict: m.verdict, reason },
        },
        now,
      );
      alerter?.raise(
        tenantId,
        {
          kind: "switched-back",
          dedupeKey: `switched-back:${m.policyId}:${m.liveSince}`,
          subject: m.policyName,
          message:
            `"${m.policyName}" is back to a dry run because ${reason}. ` +
            "Calls go out as your software sends them again. You can switch it back on from Limits.",
        },
        now,
      );
      switched.push(m.policyId);
    }
  }
  return switched;
}
