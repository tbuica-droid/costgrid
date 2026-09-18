import { toUsdString, type Nanodollars } from "@costgrid/core";
import type { BacktestResult, Proposal, ProposalIntent } from "@costgrid/db";

/**
 * Rendering for `costgrid advise`.
 *
 * The output has one job beyond listing findings: make it obvious which
 * numbers are sound and which rest on an assumption. A saving from routing and
 * a saving from refusing calls are not the same kind of claim, and a terminal
 * that prints them in the same column teaches people to treat them the same
 * way.
 */

const RULE = "─".repeat(72);

function money(nano: Nanodollars): string {
  return `$${toUsdString(nano, 2)}`;
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== "") lines.push(indent + line);
  return lines;
}

function renderBacktest(backtest: BacktestResult, intent: ProposalIntent, out: string[]): void {
  if (backtest.callsAffected === 0) {
    /*
     * The same fact means opposite things depending on what the rule is for.
     * A cap that would not have fired is sized correctly and is exactly what
     * you want to install. A route rule that would not have fired is a rule
     * with nothing to do.
     */
    out.push(
      intent === "guardrail"
        ? "    Replayed: would not have fired once over this window. It sits above" +
            "\n    everything you actually did, which is how a guardrail should be set."
        : "    Replayed over this window: would never have fired.",
    );
    return;
  }

  const amount = backtest.amount;
  // The two bases get different words on purpose. "Would have saved" and
  // "would not have been spent" describe different futures.
  const verb = backtest.basis === "estimated" ? "would have saved about" : "would not have spent";
  out.push(
    `    Replayed: ${backtest.callsAffected} of ${backtest.callsInScope} call(s), ` +
      `${verb} ${amount === undefined ? "an amount it could not price" : money(amount)}`,
  );

  if (backtest.unpriceable > 0) {
    out.push(`    ${backtest.unpriceable} call(s) could not be priced and are excluded.`);
  }
  if (backtest.firstFireAt !== undefined) {
    out.push(`    First would have fired ${new Date(backtest.firstFireAt).toISOString()}.`);
  }
  out.push(...wrap(backtest.caveat, 68, "    "));
}

export function formatProposals(proposals: readonly Proposal[], days: number): string {
  const out: string[] = [];
  out.push("");
  out.push(RULE);
  out.push(`  COSTGRID ADVISE · last ${days} day(s)`);
  out.push(RULE);

  if (proposals.length === 0) {
    out.push("");
    out.push("  Nothing to propose.");
    out.push("");
    out.push("  That is a real answer, not an empty one: every check ran and none of");
    out.push("  them cleared its threshold. Thresholds are deliberately conservative,");
    out.push("  because a list of twelve suggestions worth a dollar each teaches you");
    out.push("  to stop reading the list.");
    out.push("");
    return out.join("\n");
  }

  out.push("");
  out.push(`  ${proposals.length} proposal(s).`);
  out.push("");
  out.push("  CostGrid proposes. It does not apply anything. Every line below is a");
  out.push("  command for you to run, or not.");

  const headings: Record<ProposalIntent, string> = {
    saving: "SAVES MONEY NOW: ranked by what the replay says it would have saved",
    guardrail: "BOUNDS A RISK: saves nothing today, ranked by what is exposed",
    finding: "WORTH KNOWING: nothing to install",
  };

  let current: ProposalIntent | undefined;
  proposals.forEach((proposal, index) => {
    if (proposal.intent !== current) {
      current = proposal.intent;
      out.push("");
      out.push(`  ${headings[current]}`);
    }
    out.push("");
    out.push(`  ${index + 1}. ${proposal.headline}`);
    out.push(...wrap(proposal.evidence, 68, "     "));

    if (proposal.backtest !== undefined) {
      out.push("");
      renderBacktest(proposal.backtest, proposal.intent, out);
    }

    out.push("");
    if (proposal.command === undefined) {
      out.push("    No rule to write. This one is a change in your own code.");
    } else {
      out.push(`    ${proposal.command}`);
    }
  });

  out.push("");
  out.push(RULE);
  out.push("  Every proposed rule is --action monitor: it records what it would have");
  out.push("  done and changes nothing. Read a week of that before enforcing any of it.");
  out.push(RULE);
  out.push("");
  return out.join("\n");
}
