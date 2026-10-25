import { toUsdString } from "@costgrid/core";
import {
  AgentsRepository,
  type AuditActor,
  type AuditLog,
  type Cap,
  ControlRepository,
  type Db,
  SourcesRepository,
  type SourceRow,
  SYSTEM_ACTOR,
  toUtcDay,
} from "@costgrid/db";
import type { Alerter } from "./alerts.js";
import { safeErrorMessage } from "./import-run.js";
import { activeWorkspaceKeys, getClaudeKeyStatus, setClaudeKeyStatus } from "./key-status.js";
import { adminKeyAccount, type SecretStore } from "./secret-store.js";

/**
 * View and control: pausing and resuming an agent's keys at the provider,
 * by the owner or by a monthly cap, and recording how long each stop took.
 *
 * Only Claude keys can be paused: Anthropic's Admin API can set a key
 * inactive and back, OpenAI's cannot. An agent's Claude keys are the keys and
 * workspaces matched to it in Setup; a workspace means every key in it that
 * works at the moment of the pause. Only keys that were working are paused,
 * and a resume turns back on only what CostGrid paused.
 *
 * A cap is checked against the provider's usage report, which runs behind,
 * so a cap stops spending some time after it is crossed. Each cap pause
 * records the end of the newest usage it saw, so that delay is measured and
 * shown, never described as instant.
 */

export interface KeyControlDeps {
  readonly db: Db;
  readonly audit: AuditLog;
  /** Where the Claude admin key is kept. Absent, nothing can be paused. */
  readonly secretStore?: SecretStore | undefined;
  readonly alerter?: Alerter | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly now?: () => number;
}

/** Something the owner should be told in words: no admin key, not on the tier. */
export class ControlError extends Error {
  override readonly name = "ControlError";
}

export interface PauseRequest {
  readonly actor: AuditActor;
  readonly reason: "owner" | "cap";
  readonly usageThrough?: number | null;
  readonly capMonth?: string;
}

export interface ActionResult {
  /** Key ids paused or resumed. */
  readonly done: string[];
  readonly failed: { keyId: string; error: string }[];
  /** Keys that were already off, so CostGrid left them alone. */
  readonly skipped: string[];
}

const DAY_MS = 86_400_000;

/**
 * One control job at a time per organisation, across every KeyControl in the
 * process: an owner's click and the hourly cap check must not both decide to
 * pause the same keys.
 */
const queues = new Map<string, Promise<unknown>>();
function exclusive<T>(tenantId: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(tenantId) ?? Promise.resolve()).then(job, job);
  const settled = run.catch(() => undefined);
  queues.set(tenantId, settled);
  void settled.then(() => {
    if (queues.get(tenantId) === settled) queues.delete(tenantId);
  });
  return run;
}
const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

/** An agent's sources, split by whether CostGrid can pause them. */
export function splitSources(sources: readonly SourceRow[]): { pausable: SourceRow[]; notPausable: SourceRow[] } {
  const pausable = sources.filter((s) => s.provider === "anthropic" && (s.kind === "key" || s.kind === "workspace"));
  return { pausable, notPausable: sources.filter((s) => !pausable.includes(s)) };
}

export class KeyControl {
  readonly #deps: KeyControlDeps;
  readonly #control: ControlRepository;
  readonly #agents: AgentsRepository;
  readonly #sources: SourcesRepository;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(deps: KeyControlDeps) {
    this.#deps = deps;
    this.#control = new ControlRepository(deps.db);
    this.#agents = new AgentsRepository(deps.db);
    this.#sources = new SourcesRepository(deps.db);
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? Date.now;
  }

  /** This month so far, per agent: provider-reported cost and the end of the newest usage day seen. */
  monthToDate(tenantId: string, at = this.#now()) {
    const view = this.#agents.view(tenantId, { from: `${monthOf(at)}-01`, to: toUtcDay(at) });
    return new Map(
      view.agents.map((a) => {
        const days = a.sources.map((s) => s.lastDay).filter((d): d is string => d !== null);
        const newest = days.length ? days.reduce((x, y) => (y > x ? y : x)) : null;
        return [
          a.id,
          {
            agent: a,
            spent: a.imported.costNano,
            usageThrough: newest === null ? null : Math.min(Date.parse(`${newest}T00:00:00Z`) + DAY_MS, at),
          },
        ];
      }),
    );
  }

  pause(tenantId: string, agentId: string, p: PauseRequest): Promise<ActionResult> {
    return exclusive(tenantId, () => this.#pause(tenantId, agentId, p));
  }

  async #pause(tenantId: string, agentId: string, p: PauseRequest): Promise<ActionResult> {
    const adminKey = await this.#adminKey(tenantId);
    const sources = this.#agentSources(tenantId, agentId);
    const { pausable } = splitSources(sources);

    const targets: string[] = [];
    const skipped: string[] = [];
    const failed: ActionResult["failed"] = [];
    for (const s of pausable) {
      try {
        if (s.kind === "workspace") targets.push(...(await activeWorkspaceKeys(this.#fetch, adminKey, s.id)));
        else if ((await getClaudeKeyStatus(this.#fetch, adminKey, s.id)) === "active") targets.push(s.id);
        else skipped.push(s.id);
      } catch (error) {
        failed.push({ keyId: s.id, error: safeErrorMessage(error, adminKey) });
      }
    }

    const done: string[] = [];
    for (const keyId of [...new Set(targets)]) {
      const requestedAt = this.#now();
      const id = this.#control.startAction(tenantId, {
        agentId,
        provider: "anthropic",
        keyId,
        action: "pause",
        reason: p.reason,
        requestedAt,
        ...(p.usageThrough != null ? { usageThrough: p.usageThrough } : {}),
        ...(p.capMonth !== undefined ? { capMonth: p.capMonth } : {}),
      });
      try {
        await this.#setStatus(adminKey, keyId, "inactive");
        this.#control.finishAction(id, true, this.#now());
        done.push(keyId);
      } catch (error) {
        const message = safeErrorMessage(error, adminKey);
        this.#control.finishAction(id, false, this.#now(), message);
        failed.push({ keyId, error: message });
      }
    }

    // Nothing tried, nothing to record: an hourly cap check must not fill the audit log.
    if (targets.length > 0 || failed.length > 0 || p.reason === "owner") {
      this.#record(tenantId, agentId, "control.paused", p.actor, { reason: p.reason, done, failed: failed.length, skipped: skipped.length });
    }
    // A cap pause is reported by the cap alert, which says why.
    if (done.length > 0 && p.reason === "owner") {
      this.#alert(tenantId, agentId, "pause", `${done.length} Claude ${done.length === 1 ? "key was" : "keys were"} paused. Resume it from Limits in CostGrid.`);
    }
    return { done, failed, skipped };
  }

  /** Turns back on what CostGrid paused for the agent, whatever the tier and even if the agent is gone. */
  resume(tenantId: string, agentId: string, actor: AuditActor): Promise<ActionResult> {
    return exclusive(tenantId, () => this.#resume(tenantId, agentId, actor));
  }

  async #resume(tenantId: string, agentId: string, actor: AuditActor): Promise<ActionResult> {
    const adminKey = await this.#adminKey(tenantId);
    const done: string[] = [];
    const failed: ActionResult["failed"] = [];
    for (const paused of this.#control.pausedKeys(tenantId, agentId)) {
      const id = this.#control.startAction(tenantId, {
        agentId,
        provider: paused.provider,
        keyId: paused.keyId,
        action: "resume",
        reason: "owner",
        requestedAt: this.#now(),
      });
      try {
        await this.#setStatus(adminKey, paused.keyId, "active");
        this.#control.finishAction(id, true, this.#now());
        done.push(paused.keyId);
      } catch (error) {
        const message = safeErrorMessage(error, adminKey);
        this.#control.finishAction(id, false, this.#now(), message);
        failed.push({ keyId: paused.keyId, error: message });
      }
    }
    this.#record(tenantId, agentId, "control.resumed", actor, { done, failed: failed.length });
    if (done.length > 0) this.#alert(tenantId, agentId, "resume", `${done.length} Claude ${done.length === 1 ? "key was" : "keys were"} turned back on.`);
    return { done, failed, skipped: [] };
  }

  /**
   * Pauses each capped agent whose month-to-date cost has reached its cap,
   * once a month per cap: an owner who resumes after a cap pause is not
   * overruled, until the cap is changed. A pause that failed is tried again.
   */
  async checkCaps(only?: string): Promise<void> {
    for (const tenantId of this.#control.tenantsWithCaps()) {
      if (only !== undefined && tenantId !== only) continue;
      await exclusive(tenantId, () => this.#checkTenant(tenantId));
    }
  }

  async #checkTenant(tenantId: string): Promise<void> {
    const now = this.#now();
    const month = monthOf(now);
    const spend = this.monthToDate(tenantId, now);
    for (const [agentId, cap] of this.#control.caps(tenantId)) {
      const seen = spend.get(agentId);
      if (seen === undefined || seen.spent < cap.monthlyCap) continue;
      if (this.#control.capActedIn(tenantId, agentId, month, cap.updatedAt)) continue;

      let outcome: string;
      if (splitSources(seen.agent.sources).pausable.length === 0) {
        outcome = "It has no Claude keys CostGrid can pause, so nothing was paused.";
      } else {
        try {
          const result = await this.#pause(tenantId, agentId, { actor: SYSTEM_ACTOR, reason: "cap", usageThrough: seen.usageThrough, capMonth: month });
          outcome =
            result.done.length > 0
              ? `CostGrid paused ${result.done.length} of its Claude ${result.done.length === 1 ? "key" : "keys"}; resume from Limits.`
              : result.failed.length > 0
                ? `CostGrid could not pause its keys (${result.failed[0]!.error}) and will try again within the hour.`
                : "Its Claude keys were already off.";
        } catch (error) {
          outcome = error instanceof ControlError ? `Nothing was paused: ${error.message}` : "Nothing was paused because of an error.";
        }
      }
      this.#capReached(tenantId, agentId, cap, seen.spent, month, outcome);
    }
  }

  #capReached(tenantId: string, agentId: string, cap: Cap, spent: bigint, month: string, outcome: string): void {
    this.#deps.alerter?.raise(tenantId, {
      kind: "cap-reached",
      dedupeKey: `cap-reached:${agentId}:${month}:${cap.updatedAt}`,
      subject: agentId,
      message:
        `${this.#nameOf(tenantId, agentId)} has spent $${toUsdString(spent, 2)} this month, past its cap of ` +
        `$${toUsdString(cap.monthlyCap, 2)}, by the provider's usage report. ${outcome}`,
    });
  }

  /** Sets a key's status, and fails unless Anthropic reports the status asked for. */
  async #setStatus(adminKey: string, keyId: string, status: "active" | "inactive"): Promise<void> {
    const reported = await setClaudeKeyStatus(this.#fetch, adminKey, keyId, status);
    if (reported !== status) throw new Error(`Anthropic reported the key as ${reported}`);
  }

  #alert(tenantId: string, agentId: string, what: "pause" | "resume", sentence: string): void {
    this.#deps.alerter?.raise(tenantId, {
      kind: "key-paused",
      dedupeKey: `key-${what}:${agentId}:${this.#now()}`,
      subject: agentId,
      message: `${this.#nameOf(tenantId, agentId)}: ${sentence}`,
    });
  }

  #record(tenantId: string, agentId: string, action: string, actor: AuditActor, detail: Record<string, string | number | boolean | null | string[]>): void {
    this.#deps.audit.record(tenantId, {
      actor,
      action,
      subject: agentId,
      detail: Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v])),
    });
  }

  #nameOf(tenantId: string, agentId: string): string {
    const row = this.#deps.db.prepare("SELECT name FROM agents WHERE tenant_id = ? AND id = ?").get(tenantId, agentId) as
      | { name: string | null }
      | undefined;
    return row?.name ?? agentId;
  }

  #agentSources(tenantId: string, agentId: string): SourceRow[] {
    const today = toUtcDay(this.#now());
    return this.#sources.list(tenantId, { from: today, to: today }).filter((s) => s.agentId === agentId);
  }

  async #adminKey(tenantId: string): Promise<string> {
    const missing = new ControlError("Connect a Claude admin key in Setup first: pausing a key needs one.");
    if (this.#deps.secretStore === undefined) throw missing;
    const key = await this.#deps.secretStore.get(adminKeyAccount(tenantId, "anthropic")).catch(() => undefined);
    if (key === undefined || key === "") throw missing;
    return key;
  }
}
