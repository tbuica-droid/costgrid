import type { LcsoInput, LcsoTask, Reported } from "../../src/lcso-types.js";

/** Shared scaffolding for the LCSO tests: one period, one definition, one asOf. */

export const DAY = 86_400_000;
export const AS_OF = Date.UTC(2026, 9, 1);
export const WINDOW = 7 * DAY;

export function baseInput(tasks: readonly LcsoTask[], extra: Partial<LcsoInput> = {}): LcsoInput {
  return {
    workflowId: "wf",
    period: { from: AS_OF - 30 * DAY, to: AS_OF },
    asOf: AS_OF,
    successDefinition: { id: "def", version: "1", maturationWindowMs: WINDOW },
    tasks,
    ...extra,
  };
}

/** The reported value, or a test failure naming why it was withheld. */
export function value<T>(figure: Reported<T>): T {
  if (!figure.reported) throw new Error(`not reported: ${figure.reason}`);
  return figure.value;
}

export const reason = <T>(figure: Reported<T>) => (figure.reported ? "reported" : figure.reason);
