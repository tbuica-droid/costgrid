/**
 * Pull tool *names* out of a structure, ignoring everything else in it.
 *
 * Deliberately narrow: it reads `name`, and nothing reads `input`,
 * `arguments`, `description` or `input_schema`. Those are the customer's
 * content, and the promise is that content is forwarded and never stored.
 *
 * Names are capped in length and count so a malformed or hostile response
 * cannot push unbounded text into the database through this path.
 */
export const MAX_TOOL_NAME = 128;
export const MAX_TOOLS_PER_CALL = 64;

export function toolName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_TOOL_NAME) return undefined;
  return trimmed;
}

/** De-duplicate and cap a list of tool names. */
export function cappedTools(names: readonly (string | undefined)[]): string[] {
  const seen: string[] = [];
  for (const name of names) {
    if (name === undefined || seen.includes(name)) continue;
    seen.push(name);
    if (seen.length >= MAX_TOOLS_PER_CALL) break;
  }
  return seen;
}
