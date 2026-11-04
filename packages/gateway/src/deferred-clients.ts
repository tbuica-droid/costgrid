import type { DeferredStatus, DeferredStatusUpdate } from "@costgrid/db";

/**
 * The two providers' batch APIs, behind one shape.
 *
 * Anthropic takes the requests inline (Message Batches). OpenAI takes a JSONL
 * file uploaded first, then a batch over it. Both answer later with a JSONL
 * file of results, one line per request, in no particular order.
 *
 * Neither has been run against a live account: built and tested against stubs
 * that follow the published shapes, like the Bedrock and Vertex channels were.
 */

export interface DeferredRequest {
  readonly custom_id: string;
  readonly params: unknown;
}

/** One result line, reduced to what pricing needs. The answer itself is not kept. */
export interface ResultLine {
  readonly customId: string;
  /** The provider's response body for a request that succeeded, to read usage from. */
  readonly response?: unknown;
  /** Why it did not, in the provider's words: `errored`, `expired`, an HTTP status. */
  readonly failure?: string;
}

export interface Credential {
  readonly apiKey: string;
  readonly baseUrl: string;
}

export interface BatchClient {
  submit(requests: readonly DeferredRequest[], cred: Credential): Promise<{ providerBatchId: string; status: DeferredStatusUpdate }>;
  status(providerBatchId: string, cred: Credential): Promise<DeferredStatusUpdate>;
  /** The raw JSONL of results (or of errors), as the provider serves it. */
  results(ref: string, cred: Credential): Promise<Response>;
  parseLine(line: string): ResultLine | undefined;
}

class BatchApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BatchApiError";
  }
}

export { BatchApiError };

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    // The provider's own message, cut short: it says what was wrong with the
    // request, and never contains the key.
    const text = (await response.text().catch(() => "")).slice(0, 300);
    throw new BatchApiError(response.status, `${what} failed with ${response.status}${text ? `: ${text}` : ""}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const time = (v: unknown): number | undefined =>
  typeof v === "string" ? Date.parse(v) || undefined : typeof v === "number" ? v * 1000 : undefined;

// ------------------------------------------------------------------ Anthropic

export function anthropicBatchClient(doFetch: typeof fetch): BatchClient {
  const headers = (cred: Credential): Record<string, string> => ({
    "x-api-key": cred.apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  });

  const statusOf = (body: Record<string, unknown>): DeferredStatusUpdate => {
    const counts = record(body["request_counts"]) ?? {};
    const processing = body["processing_status"];
    const ended = processing === "ended";
    // An ended batch can still have every request expired or canceled; the
    // counts say so, and pricing reads the lines either way.
    const status: DeferredStatus = ended ? "ended" : "in_progress";
    return {
      status,
      succeededCount: num(counts["succeeded"]),
      erroredCount: num(counts["errored"]) + num(counts["canceled"]) + num(counts["expired"]),
      ...(typeof body["results_url"] === "string" ? { resultsRef: body["results_url"] } : {}),
      ...(ended ? { endedAt: time(body["ended_at"]) ?? Date.now() } : {}),
    };
  };

  return {
    async submit(requests, cred) {
      const body = await json(
        await doFetch(new URL("/v1/messages/batches", cred.baseUrl), {
          method: "POST",
          headers: headers(cred),
          body: JSON.stringify({ requests }),
        }),
        "creating the batch",
      );
      return { providerBatchId: String(body["id"]), status: statusOf(body) };
    },
    async status(id, cred) {
      return statusOf(
        await json(
          await doFetch(new URL(`/v1/messages/batches/${encodeURIComponent(id)}`, cred.baseUrl), {
            headers: headers(cred),
          }),
          "reading the batch",
        ),
      );
    },
    async results(ref, cred) {
      // The results address comes from the provider; it must be on the same
      // host as the API, or the key would be sent somewhere else.
      const url = new URL(ref);
      if (url.origin !== new URL(cred.baseUrl).origin) {
        throw new BatchApiError(502, "the provider gave a results address on another host; not followed");
      }
      const response = await doFetch(url, { headers: headers(cred) });
      if (!response.ok) throw new BatchApiError(response.status, `reading results failed with ${response.status}`);
      return response;
    },
    parseLine(line) {
      const parsed = record(JSON.parse(line));
      const customId = parsed?.["custom_id"];
      if (typeof customId !== "string") return undefined;
      const result = record(parsed?.["result"]);
      if (result?.["type"] === "succeeded") return { customId, response: result["message"] };
      return { customId, failure: typeof result?.["type"] === "string" ? result["type"] : "unknown" };
    },
  };
}

// --------------------------------------------------------------------- OpenAI

export function openAiBatchClient(doFetch: typeof fetch): BatchClient {
  const auth = (cred: Credential): Record<string, string> => ({ authorization: `Bearer ${cred.apiKey}` });

  const statusOf = (body: Record<string, unknown>): DeferredStatusUpdate => {
    const counts = record(body["request_counts"]) ?? {};
    const raw = body["status"];
    const status: DeferredStatus =
      raw === "completed"
        ? "ended"
        : raw === "failed"
          ? "failed"
          : raw === "expired"
            ? "expired"
            : raw === "cancelled"
              ? "canceled"
              : "in_progress";
    const errors = record(body["errors"]);
    const firstError = Array.isArray(errors?.["data"]) ? record(errors["data"][0])?.["message"] : undefined;
    return {
      status,
      succeededCount: num(counts["completed"]),
      erroredCount: num(counts["failed"]),
      ...(typeof body["output_file_id"] === "string" ? { resultsRef: body["output_file_id"] } : {}),
      ...(typeof body["error_file_id"] === "string" ? { errorsRef: body["error_file_id"] } : {}),
      ...(status !== "in_progress"
        ? { endedAt: time(body["completed_at"] ?? body["failed_at"] ?? body["expired_at"] ?? body["cancelled_at"]) ?? Date.now() }
        : {}),
      ...(typeof firstError === "string" ? { errorMessage: firstError.slice(0, 300) } : {}),
    };
  };

  return {
    async submit(requests, cred) {
      const lines = requests
        .map((r) => JSON.stringify({ custom_id: r.custom_id, method: "POST", url: "/v1/chat/completions", body: r.params }))
        .join("\n");
      const form = new FormData();
      form.append("purpose", "batch");
      form.append("file", new Blob([lines], { type: "application/jsonl" }), "costgrid-batch.jsonl");
      const file = await json(
        await doFetch(new URL("/v1/files", cred.baseUrl), { method: "POST", headers: auth(cred), body: form }),
        "uploading the batch file",
      );
      const body = await json(
        await doFetch(new URL("/v1/batches", cred.baseUrl), {
          method: "POST",
          headers: { ...auth(cred), "content-type": "application/json" },
          body: JSON.stringify({ input_file_id: file["id"], endpoint: "/v1/chat/completions", completion_window: "24h" }),
        }),
        "creating the batch",
      );
      return { providerBatchId: String(body["id"]), status: statusOf(body) };
    },
    async status(id, cred) {
      return statusOf(
        await json(
          await doFetch(new URL(`/v1/batches/${encodeURIComponent(id)}`, cred.baseUrl), { headers: auth(cred) }),
          "reading the batch",
        ),
      );
    },
    async results(ref, cred) {
      const response = await doFetch(new URL(`/v1/files/${encodeURIComponent(ref)}/content`, cred.baseUrl), {
        headers: auth(cred),
      });
      if (!response.ok) throw new BatchApiError(response.status, `reading results failed with ${response.status}`);
      return response;
    },
    parseLine(line) {
      const parsed = record(JSON.parse(line));
      const customId = parsed?.["custom_id"];
      if (typeof customId !== "string") return undefined;
      const response = record(parsed?.["response"]);
      const statusCode = response?.["status_code"];
      if (statusCode === 200) return { customId, response: response?.["body"] };
      return { customId, failure: typeof statusCode === "number" ? `status ${statusCode}` : "error" };
    },
  };
}
