/**
 * A terminating server-sent-events error event.
 *
 * Lives in its own module rather than beside the adapters that use it, because
 * `index.ts` imports every adapter: an adapter importing back from `index.ts`
 * would evaluate this reference while it is still in the temporal dead zone,
 * and the failure would be a ReferenceError at startup rather than anything
 * the type checker could catch.
 *
 * Anthropic and OpenAI SDKs both surface an `error` event as a thrown error
 * rather than as content, which is exactly the outcome wanted when a stream is
 * cut: the caller gets an exception naming the policy, not a half-finished
 * tool call to guess about.
 */
export function sseError(message: string): string {
  const payload = JSON.stringify({
    type: "error",
    error: { type: "costgrid_tool_blocked", message },
  });
  return `event: error\ndata: ${payload}\n\n`;
}
