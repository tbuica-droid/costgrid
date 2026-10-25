/**
 * Whether a tool the agent called hands the job to a person.
 *
 * Only tool names are recorded, never their arguments, and nobody names
 * these tools the same way: `handoff_to_human`, `escalateTicket`,
 * `transfer-to-agent`. The name is split into words and matched on words
 * that mean a person takes over. "transfer" alone is not enough, so
 * `transfer_funds` is not a hand-off; it must be a transfer to an agent,
 * a human, a person or support.
 */

/** Words that on their own mean a person takes over. */
export const DEFAULT_ESCALATION_WORDS: readonly string[] = ["handoff", "handover", "human", "operator"];

const TRANSFER_TO = new Set(["agent", "human", "person", "support", "operator"]);

/** `handoff_to_human` → ["handoff", "to", "human"]; `escalateTicket` → ["escalate", "ticket"]. */
export function toolWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

export function matchesEscalation(toolName: string): boolean {
  const words = toolWords(toolName);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const next = words[i + 1];
    if (DEFAULT_ESCALATION_WORDS.includes(word) || word.startsWith("escalat")) return true;
    if ((word === "hand" && next === "off") || (word === "hand" && next === "over")) return true;
    if (word === "live" && next === "agent") return true;
    if (word === "transfer" && words.slice(i + 1, i + 3).some((w) => TRANSFER_TO.has(w))) return true;
  }
  return false;
}
