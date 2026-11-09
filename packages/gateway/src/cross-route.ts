import {
  claudeResponseToOpenAi,
  claudeToOpenAi,
  ClaudeToOpenAiStream,
  findModelPrice,
  fitEffort,
  isOpenModel,
  openAiResponseToClaude,
  openAiToClaude,
  OpenAiToClaudeStream,
  parseOpenModel,
  type Provider,
  type StreamTranslator,
  type Translated,
  type WireFormat,
} from "@costgrid/core";
import { adapterFor, openAdapter, type ProviderAdapter } from "./providers/index.js";

/**
 * Sending a call somewhere other than where it was addressed (v3, phase 3).
 *
 * A route rule can now name a model on the other provider, or on an
 * open-model endpoint. The caller still speaks its own format: the request is
 * translated on the way out and the answer on the way back, buffered or
 * streamed. Metering reads the target's own response with the target's own
 * parser, so the cost is exact whichever way the caller sees it.
 *
 * Bedrock and Vertex callers are not translated yet: Bedrock streams binary
 * frames, and the plan puts both channels after the direct APIs.
 */

/** The wire format each adapter speaks. */
export function formatOf(id: Provider): WireFormat {
  return id === "openai" || id === "open" ? "openai" : "anthropic";
}

/** Which adapter serves `model`, for a call that arrived on `caller`. */
export function targetAdapterFor(model: string, caller: ProviderAdapter): ProviderAdapter {
  if (isOpenModel(model)) return openAdapter;
  const provider = findModelPrice(model)?.provider;
  if (provider === undefined || formatOf(provider) === formatOf(caller.id)) return caller;
  return adapterFor(provider);
}

/** The model name the target itself expects: an open model without its endpoint prefix. */
export function upstreamModel(model: string): string {
  return parseOpenModel(model)?.model ?? model;
}

/**
 * The body to send to `target` for `model`, translated when the formats
 * differ. Not ok means the call cannot be sent there faithfully; the reason
 * goes to the decision log and the call stays where it was addressed.
 */
export function requestFor(caller: ProviderAdapter, target: ProviderAdapter, body: unknown, model: string): Translated<unknown> {
  const name = upstreamModel(model);
  if (formatOf(caller.id) === formatOf(target.id)) {
    // The effort a caller named may not exist on the model it is moved to.
    const moved = target.withModel(body, name);
    return { ok: true, body: target.id === "open" ? moved : fitEffort(formatOf(target.id), name, moved) };
  }
  if (caller.id === "bedrock" || caller.id === "vertex") {
    return { ok: false, reason: `${caller.id} requests are not translated to other formats yet` };
  }
  return formatOf(caller.id) === "anthropic"
    ? claudeToOpenAi(body, name, target.id === "open" ? "open" : "openai")
    : openAiToClaude(body, name);
}

/** A buffered answer from `target`, in the format the caller spoke. */
export function responseFor(caller: ProviderAdapter, target: ProviderAdapter, payload: unknown, model: string): unknown {
  if (formatOf(caller.id) === formatOf(target.id)) return payload;
  return formatOf(caller.id) === "anthropic" ? openAiResponseToClaude(payload, model) : claudeResponseToOpenAi(payload, model);
}

/** A translator for a streamed answer, or undefined when the formats match. */
export function streamFor(
  caller: ProviderAdapter,
  target: ProviderAdapter,
  model: string,
  body: unknown,
): StreamTranslator | undefined {
  if (formatOf(caller.id) === formatOf(target.id)) return undefined;
  if (formatOf(caller.id) === "anthropic") return new OpenAiToClaudeStream(model);
  const options = (body as { stream_options?: { include_usage?: unknown } } | null)?.stream_options;
  return new ClaudeToOpenAiStream(model, options?.include_usage === true);
}
