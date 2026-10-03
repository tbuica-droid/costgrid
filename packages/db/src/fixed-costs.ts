import { randomUUID } from "node:crypto";
import type { Nanodollars, PolicyScope } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * The costs of running AI that never appear on a model provider's invoice.
 *
 * EY's "Total Cost of Agents" splits the cost of an agent into seven
 * categories and observes that most business cases only count the first three
 * (tokens, subscriptions, platform). Curcio's Levelized Cost of AI makes the
 * same argument from the other side: comparing deployments needs full
 * lifecycle cost per unit of useful output, not the API bill alone
 * (arXiv:2509.02596).
 *
 * CostGrid meters the token line exactly. The others it cannot observe, so
 * they are entered here, by hand, as a monthly figure, and every place that
 * shows them keeps them apart from metered spend and labels them "entered".
 * A typed-in number must never be mistaken for a measured one.
 */

/**
 * EY's categories, minus the two CostGrid already covers or cannot honestly
 * offer: tokens (metered) and the speculative "AI taxes" line, which EY itself
 * marks as not existing yet.
 */
export const FIXED_COST_CATEGORIES = {
  subscriptions: "Subscriptions and licences",
  platform: "Platform and infrastructure",
  governance: "Governance and oversight",
  change: "Organisational change and training",
  failure: "Failure and recovery",
  other: "Other",
} as const;

export type FixedCostCategory = keyof typeof FIXED_COST_CATEGORIES;

export function isFixedCostCategory(value: unknown): value is FixedCostCategory {
  return typeof value === "string" && Object.hasOwn(FIXED_COST_CATEGORIES, value);
}

export interface FixedCost {
  readonly id: string;
  readonly label: string;
  readonly category: FixedCostCategory;
  readonly scope: PolicyScope;
  readonly monthlyAmount: Nanodollars;
  /** `YYYY-MM`, inclusive. */
  readonly startsMonth: string;
  /** `YYYY-MM`, inclusive; null while it is still running. */
  readonly endsMonth: string | null;
  readonly createdAt: number;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export class FixedCosts {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  add(
    tenantId: string,
    input: Omit<FixedCost, "id" | "createdAt" | "endsMonth"> & { endsMonth?: string | null },
    at = Date.now(),
  ): string {
    const label = input.label.trim();
    if (label === "" || label.length > 80) throw new RangeError("label must be 1 to 80 characters");
    if (!isFixedCostCategory(input.category)) throw new RangeError("unknown category");
    if (input.monthlyAmount < 0n) throw new RangeError("amount cannot be negative");
    if (!MONTH.test(input.startsMonth)) throw new RangeError("startsMonth must be YYYY-MM");
    const ends = input.endsMonth ?? null;
    if (ends !== null && (!MONTH.test(ends) || ends < input.startsMonth)) {
      throw new RangeError("endsMonth must be YYYY-MM and not before startsMonth");
    }

    const id = randomUUID();
    const scopeValue =
      input.scope.kind === "agent"
        ? input.scope.agentId
        : input.scope.kind === "department"
          ? input.scope.department
          : null;
    this.#db
      .prepare(
        `INSERT INTO fixed_costs (id, tenant_id, label, category, scope_kind, scope_value,
                                  monthly_amount, starts_month, ends_month, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, tenantId, label, input.category, input.scope.kind, scopeValue,
        input.monthlyAmount, input.startsMonth, ends, at);
    return id;
  }

  remove(tenantId: string, id: string): boolean {
    return (
      this.#db.prepare("DELETE FROM fixed_costs WHERE tenant_id = ? AND id = ?").run(tenantId, id)
        .changes > 0
    );
  }

  list(tenantId: string): FixedCost[] {
    const rows = this.#db
      .prepare(
        `SELECT id, label, category, scope_kind AS scopeKind, scope_value AS scopeValue,
                monthly_amount AS monthlyAmount, starts_month AS startsMonth,
                ends_month AS endsMonth, created_at AS createdAt
         FROM fixed_costs WHERE tenant_id = ? ORDER BY starts_month, label`,
      )
      .safeIntegers(true)
      .all(tenantId) as Record<string, string | bigint | null>[];
    return rows.map((r) => ({
      id: r["id"] as string,
      label: r["label"] as string,
      category: r["category"] as FixedCostCategory,
      scope:
        r["scopeKind"] === "agent"
          ? { kind: "agent", agentId: r["scopeValue"] as string }
          : r["scopeKind"] === "department"
            ? { kind: "department", department: r["scopeValue"] as string }
            : { kind: "tenant" },
      monthlyAmount: r["monthlyAmount"] as bigint,
      startsMonth: r["startsMonth"] as string,
      endsMonth: (r["endsMonth"] as string | null) ?? null,
      createdAt: Number(r["createdAt"]),
    }));
  }

  /** Costs in force during one calendar month (`YYYY-MM`). */
  forMonth(tenantId: string, month: string): FixedCost[] {
    return this.list(tenantId).filter(
      (c) => c.startsMonth <= month && (c.endsMonth === null || c.endsMonth >= month),
    );
  }
}
