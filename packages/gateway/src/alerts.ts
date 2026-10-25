import {
  type Nanodollars,
  type Policy,
  type PolicyDecision,
  toUsdString,
  usd,
} from "@costgrid/core";
import {
  type AlertInput,
  type AlertsRepository,
  Insights,
  type Db,
  type StoredAlert,
  trailingWindow,
} from "@costgrid/db";
import type { FastifyBaseLogger } from "fastify";

/**
 * Telling a person when a limit fires, without slowing a single call.
 *
 * Everything here runs after the enforcement decision has been made, and none
 * of it can change that decision or delay the caller. Raising an alert is one
 * indexed insert; delivering it is a network call that happens on its own
 * time, and a failed delivery is recorded against the alert rather than
 * retried forever or surfaced to the caller.
 */

/** What the desktop app is handed to show a notification. */
export interface AlertNotice {
  readonly tenantId: string;
  readonly kind: StoredAlert["kind"];
  readonly title: string;
  readonly body: string;
}

export interface AlerterDeps {
  readonly alerts: AlertsRepository;
  readonly log: FastifyBaseLogger;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Self-hosted: one address for everything, from the environment. */
  readonly envWebhookUrl?: string | undefined;
  /** Desktop: show it on this computer. */
  readonly onAlert?: ((notice: AlertNotice) => void) | undefined;
}

const TITLES: Record<StoredAlert["kind"], string> = {
  "budget-warning": "Budget limit reached",
  blocked: "CostGrid refused a call",
  downgraded: "Switched to a cheaper model",
  "runaway-run": "A run is costing far more than usual",
  stopped: "Agent stopped",
  "key-expiring": "An admin key expires soon",
  "key-paused": "An agent's keys were paused or resumed",
  "cap-reached": "An agent reached its monthly cap",
  test: "CostGrid test alert",
};

export class Alerter {
  readonly #deps: AlerterDeps;
  readonly #fetch: typeof fetch;
  /**
   * Keys already raised by this process. A team over its monthly budget hits
   * the same key on every call; this keeps that from being a database write
   * each time. The database's unique key is still what guarantees one alert.
   */
  readonly #seen = new Set<string>();

  constructor(deps: AlerterDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetchImpl ?? fetch;
  }

  /**
   * Record an alert and send it, unless the same alert was already raised.
   *
   * Never throws: this is called on the metering path, and an alert that
   * cannot be written is a lost notification, not a reason to fail a call.
   */
  raise(tenantId: string, input: AlertInput, at = Date.now()): void {
    const memo = `${tenantId}\u0000${input.dedupeKey}`;
    if (this.#seen.has(memo)) return;
    if (this.#seen.size > 10_000) this.#seen.clear();
    this.#seen.add(memo);

    let stored: StoredAlert | undefined;
    try {
      stored = this.#deps.alerts.raise(tenantId, input, at);
    } catch (error) {
      this.#deps.log.error({ err: error, kind: input.kind }, "could not record an alert");
      return;
    }
    if (stored === undefined) return;
    void this.deliver(stored);
  }

  /** Send one alert everywhere it is configured to go. Resolves; never rejects. */
  async deliver(alert: StoredAlert): Promise<{ delivered: boolean; error?: string }> {
    const { alerts, log, onAlert, envWebhookUrl } = this.#deps;
    const title = TITLES[alert.kind];

    try {
      if (onAlert !== undefined && alerts.settings(alert.tenantId).desktop) {
        onAlert({ tenantId: alert.tenantId, kind: alert.kind, title, body: alert.message });
      }
    } catch (error) {
      log.warn({ err: error }, "desktop notification failed");
    }

    let url: string | undefined;
    try {
      url = alerts.webhookUrl(alert.tenantId) ?? envWebhookUrl;
    } catch (error) {
      log.error({ err: error }, "could not read the alert address");
    }
    if (url === undefined) {
      // Nowhere else to send it. Recorded, and shown in the console.
      return { delivered: false };
    }

    const text = `CostGrid: ${title}. ${alert.message}`;
    try {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // `text` is what Slack and most chat webhooks read, `content` is
        // Discord's name for it, and `costgrid` carries the same facts for a
        // receiver that wants to route on them.
        body: JSON.stringify({
          text,
          content: text,
          costgrid: {
            kind: alert.kind,
            subject: alert.subject,
            message: alert.message,
            occurredAt: new Date(alert.occurredAt).toISOString(),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`the receiver answered HTTP ${response.status}`);
      alerts.markDelivered(alert.id);
      return { delivered: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        alerts.markFailed(alert.id, message);
      } catch {
        // The database is the problem; the log line below still says so.
      }
      log.warn({ kind: alert.kind, error: message }, "alert could not be delivered");
      return { delivered: false, error: message };
    }
  }
}

/** `2026-10-03T14` and friends: the window a dedupe key is drawn over. */
function windowKey(at: number, unit: "hour" | "day" | "month"): string {
  const iso = new Date(at).toISOString();
  return unit === "month" ? iso.slice(0, 7) : unit === "day" ? iso.slice(0, 10) : iso.slice(0, 13);
}

/**
 * The alerts one enforcement decision should raise.
 *
 * Pure, so what alerts when is testable without a gateway. Stop rules are
 * left out on purpose: the person who pressed stop is the one who would be
 * told, and they raise their own alert when they press it.
 */
export function decisionAlerts(
  decision: PolicyDecision,
  policies: readonly Policy[],
  caller: { readonly agentId: string; readonly department: string },
  runId: string,
  at: number,
): AlertInput[] {
  const byId = new Map(policies.map((p) => [p.id, p]));
  const who = `${caller.agentId} (${caller.department})`;
  const out: AlertInput[] = [];

  for (const v of decision.violations) {
    const policy = byId.get(v.policyId);
    if (policy === undefined || policy.rule.kind === "stop") continue;
    const kind = policy.rule.kind;

    if (kind === "budget") {
      const unit = policy.rule.window === "day" ? "day" : "month";
      const measuring = v.action === "monitor";
      out.push({
        kind: v.action === "block" ? "blocked" : "budget-warning",
        dedupeKey: `budget:${v.policyId}:${v.action}:${windowKey(at, unit)}`,
        subject: caller.agentId,
        message:
          `"${v.policyName}": ${v.reason}.` +
          (v.action === "block"
            ? ` Calls from ${who} are being refused until the ${unit} ends.`
            : measuring
              ? " This limit is only measuring, so nothing was stopped."
              : " Calls are still going through."),
      });
      continue;
    }

    if (v.action !== "block") continue;

    const perRun = kind === "run-budget" || kind === "run-steps" || kind === "run-depth";
    out.push({
      kind: "blocked",
      dedupeKey: perRun
        ? `run:${v.policyId}:${runId}`
        : `blocked:${v.policyId}:${caller.agentId}:${windowKey(at, "hour")}`,
      subject: perRun ? runId : caller.agentId,
      message:
        `"${v.policyName}" refused a call from ${who}: ${v.reason}. ` +
        "Nothing was sent to the provider and nothing was billed.",
    });
  }

  const route = decision.route;
  if (decision.allowed && route?.fallback === true && route.applied) {
    out.push({
      kind: "downgraded",
      dedupeKey: `fallback:${route.policyId}:${windowKey(at, "day")}`,
      subject: caller.agentId,
      message:
        `"${route.policyName}" is over budget, so calls from ${who} now go to ` +
        `${route.toModel} instead of ${route.fromModel}. They keep working at the cheaper rate.`,
    });
  }
  return out;
}

/**
 * Spotting a run that is going wrong while it is still running.
 *
 * Bai et al. found that agents cannot predict their own cost before a task
 * starts (arXiv:2604.22750), so CostGrid does not try. What it can do is
 * notice, mid-run, that this run has already spent several times what this
 * agent's runs usually cost at the 95th percentile. That needs no prediction,
 * only the agent's own history.
 *
 * Warns; never blocks. A run limit is the control for refusing; this is the
 * tap on the shoulder that says one is worth setting.
 */
export class RunawayWatch {
  readonly #insights: Insights;
  readonly #cache = new Map<string, { at: number; runs: number; p95: Nanodollars }>();
  readonly #multiple: number;
  readonly #minRuns: number;
  readonly #floor: Nanodollars;
  static readonly TTL_MS = 10 * 60 * 1000;

  constructor(db: Db, options: { multiple?: number; minRuns?: number; floorUsd?: string } = {}) {
    this.#insights = new Insights(db);
    this.#multiple = options.multiple ?? 3;
    this.#minRuns = options.minRuns ?? 20;
    // Below this, a run is too cheap for "three times usual" to be worth a
    // message, whatever the ratio.
    this.#floor = usd(options.floorUsd ?? "0.50");
  }

  /** The alert to raise, or undefined when this run looks ordinary. */
  check(
    tenantId: string,
    agentId: string,
    runId: string,
    spentSoFar: Nanodollars,
    at = Date.now(),
  ): AlertInput | undefined {
    if (spentSoFar < this.#floor) return undefined;

    const key = `${tenantId}\u0000${agentId}`;
    let profile = this.#cache.get(key);
    if (profile === undefined || at - profile.at > RunawayWatch.TTL_MS) {
      const spread = this.#insights.runSpread(tenantId, trailingWindow(30, at), agentId)[0];
      profile = { at, runs: spread?.runs ?? 0, p95: spread?.p95 ?? 0n };
      this.#cache.set(key, profile);
    }
    if (profile.runs < this.#minRuns || profile.p95 <= 0n) return undefined;

    const threshold = profile.p95 * BigInt(Math.round(this.#multiple * 100)) / 100n;
    if (spentSoFar <= threshold) return undefined;

    return {
      kind: "runaway-run",
      dedupeKey: `runaway:${runId}`,
      subject: runId,
      message:
        `Run ${runId} from ${agentId} has already spent $${toUsdString(spentSoFar, 2)}, more than ` +
        `${this.#multiple}x the $${toUsdString(profile.p95, 2)} that 95% of its last ${profile.runs} ` +
        "runs stayed under. It is still running. A per-run limit would stop runs like this one.",
    };
  }
}
