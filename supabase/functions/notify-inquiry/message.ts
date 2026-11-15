/**
 * How notify-inquiry words its email. Kept free of Deno and network imports
 * so the repository's tests can run it with Node.
 */

export const INBOX = "support@costgrid.org";

export interface Inquiry {
  company: string;
  spend: string;
  notes: string | null;
  created_at: string;
  /** null on the first email for this person. */
  previous_notified_at: string | null;
}

/** Newlines in a header would let a visitor add headers of their own. */
function oneLine(s: string, max: number): string {
  return s.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

export function buildMessage(q: Inquiry, email: string): { subject: string; text: string } {
  const isNew = q.previous_notified_at === null;
  const notes = (q.notes ?? "").trim();
  const wantsQuote = /quote|price|pricing|control/i.test(notes);
  const subject = oneLine(
    `${isNew ? "New website inquiry" : "Updated website inquiry"}${wantsQuote ? " (quote)" : ""}: ${q.company}`,
    160,
  );
  const text = [
    `${email} ${isNew ? "answered" : "changed their answers to"} the questions on costgrid.org.`,
    "",
    `Company or team: ${q.company}`,
    `Monthly AI spend: ${q.spend}`,
    "What their agents do, and any quote request:",
    notes || "(left blank)",
    "",
    `Signed up: ${q.created_at}`,
    "",
    "Reply to this email to answer them directly.",
  ].join("\n");
  return { subject, text };
}
