import { findModelPrice, toUsdString } from "@costgrid/core";
import { ADAPTERS } from "./providers/index.js";

/**
 * Prove a channel works, against the customer's own account.
 *
 * Bedrock and Vertex were built without an AWS or GCP account to test against.
 * The signature is verified against Amazon's published example and the frame
 * decoder against the canonical CRC vector, but nothing in this repository has
 * ever spoken to either service — and saying "it should work" is not a thing a
 * cost tool gets to say.
 *
 * So the verification is handed to whoever has the account. One real call, the
 * smallest possible, reporting exactly which stage failed: credentials, route,
 * response shape, or pricing. A failure here is a failure of this integration,
 * not of the customer's setup, and the output is written to be pasteable into
 * an issue.
 */

export interface PreflightStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PreflightResult {
  readonly provider: string;
  readonly ok: boolean;
  readonly steps: readonly PreflightStep[];
}

export interface PreflightOptions {
  readonly provider: string;
  readonly credential: string;
  readonly baseUrl?: string | undefined;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}

export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  const steps: PreflightStep[] = [];
  const doFetch = options.fetchImpl ?? fetch;

  const adapter = ADAPTERS.find((a) => a.id === options.provider);
  if (!adapter) {
    return {
      provider: options.provider,
      ok: false,
      steps: [
        {
          name: "provider",
          ok: false,
          detail: `unknown provider; try one of ${ADAPTERS.map((a) => a.id).join(", ")}`,
        },
      ],
    };
  }

  // 1. Can this model be priced at all? Checked first because it needs no
  //    network and a miss here explains every zero that would follow.
  const price = findModelPrice(options.model);
  steps.push({
    name: "pricing",
    ok: price !== undefined,
    detail:
      price === undefined
        ? `${options.model} is not in the price catalog, so its spend would record as unpriced`
        : `${options.model} prices as ${price.id} ` +
          // Catalog rates are nanodollars per token; the readable unit is per
          // million, which is how every provider publishes them.
          `($${toUsdString(price.input * 1_000_000n, 2)}/Mtok in, ` +
          `$${toUsdString(price.output * 1_000_000n, 2)}/Mtok out)`,
  });

  const baseUrl = options.baseUrl ?? adapter.defaultBaseUrl;
  const body = adapter.prepareBody({
    model: options.model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
  }).body;
  const bytes = JSON.stringify(body);

  let url: URL;
  try {
    url = new URL(adapter.upstreamPath(options.model, false), baseUrl);
    steps.push({ name: "route", ok: true, detail: `POST ${url.toString()}` });
  } catch (error) {
    steps.push({
      name: "route",
      ok: false,
      detail: `could not build an upstream URL: ${String(error)}`,
    });
    return { provider: options.provider, ok: false, steps };
  }

  // 2. Credentials. A signature or token failure is the likeliest thing to be
  //    wrong, and it is worth separating from a transport failure.
  let headers: Record<string, string>;
  try {
    headers = {
      "content-type": "application/json",
      ...(await adapter.authHeaders(options.credential, { method: "POST", url, body: bytes })),
    };
    steps.push({
      name: "credentials",
      ok: true,
      detail: `built ${Object.keys(headers).filter((h) => h !== "content-type").join(", ")}`,
    });
  } catch (error) {
    steps.push({
      name: "credentials",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { provider: options.provider, ok: false, steps };
  }

  // 3. The call itself.
  let response: Response;
  let text: string;
  try {
    response = await doFetch(url, { method: "POST", headers, body: bytes });
    text = await response.text();
  } catch (error) {
    steps.push({
      name: "request",
      ok: false,
      detail: `could not reach ${url.host}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { provider: options.provider, ok: false, steps };
  }

  if (!response.ok) {
    steps.push({
      name: "request",
      ok: false,
      // The provider's own message is the actionable part.
      detail: `${response.status}: ${text.slice(0, 400)}`,
    });
    return { provider: options.provider, ok: false, steps };
  }
  steps.push({ name: "request", ok: true, detail: `${response.status} in one call` });

  // 4. Did the response parse into usage? This is the stage most likely to be
  //    wrong in an integration written without an account to test against.
  try {
    const parsed = adapter.parseBufferedResponse(JSON.parse(text));
    const usage = parsed.usage;
    const ok = usage !== undefined && usage.inputTokens + usage.outputTokens > 0;
    steps.push({
      name: "usage",
      ok,
      detail: ok
        ? `read ${usage!.inputTokens} in / ${usage!.outputTokens} out` +
          (usage!.cacheReadTokens ? ` / ${usage!.cacheReadTokens} cached` : "")
        : "the response parsed but reported no usage, so calls would record as unpriced. " +
          `Raw response: ${text.slice(0, 300)}`,
    });
  } catch (error) {
    steps.push({
      name: "usage",
      ok: false,
      detail: `could not parse the response: ${String(error)}. Raw: ${text.slice(0, 300)}`,
    });
  }

  return { provider: options.provider, ok: steps.every((s) => s.ok), steps };
}

export function formatPreflight(result: PreflightResult): string {
  const lines = [`\n  Preflight — ${result.provider}\n`];
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? "PASS" : "FAIL"}  ${step.name.padEnd(12)} ${step.detail}`);
  }
  lines.push(
    "",
    result.ok
      ? "  Everything this channel needs is working against your account."
      : "  Something is wrong. If the failing stage is `usage` or `route`, that is a bug in\n" +
        "  CostGrid rather than in your setup — please paste this output into an issue.",
    "",
  );
  return lines.join("\n");
}
