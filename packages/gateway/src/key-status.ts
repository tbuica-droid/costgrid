import { ADMIN_ENDPOINTS, getJson } from "./importers/index.js";

/**
 * Pausing and resuming Claude API keys through Anthropic's Admin API.
 *
 * `inactive` stops a key working and `active` turns it back on; both are
 * reversible. `archived` is not, so it is never sent. OpenAI has no
 * documented way to pause a key, so nothing here speaks to OpenAI.
 *
 * The admin key goes in a header and nowhere else; an error carries the
 * provider's message, which the caller passes through `safeErrorMessage`
 * before it is stored or shown.
 */

export type ClaudeKeyStatus = "active" | "inactive";

const headers = (adminKey: string) => ({
  "x-api-key": adminKey,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
});

/** Sets one key's status, and returns the status Anthropic reports back. */
export async function setClaudeKeyStatus(
  doFetch: typeof fetch,
  adminKey: string,
  keyId: string,
  status: ClaudeKeyStatus,
): Promise<string> {
  const url = new URL(`/v1/organizations/api_keys/${encodeURIComponent(keyId)}`, ADMIN_ENDPOINTS.anthropic);
  const init: RequestInit = { method: "POST", headers: headers(adminKey), body: JSON.stringify({ status }) };
  const response = doFetch === fetch ? await doFetch(url, { ...init, signal: AbortSignal.timeout(30_000) }) : await doFetch(url, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  if (!response.ok) {
    const error = body["error"] as Record<string, unknown> | undefined;
    const detail = typeof error?.["message"] === "string" ? error["message"] : text.slice(0, 200);
    throw new Error(`provider returned ${response.status}: ${detail}`);
  }
  return typeof body["status"] === "string" ? body["status"] : "unknown";
}

/** One key's status as Anthropic reports it: "active", "inactive", "archived" or "expired". */
export async function getClaudeKeyStatus(doFetch: typeof fetch, adminKey: string, keyId: string): Promise<string> {
  const url = new URL(`/v1/organizations/api_keys/${encodeURIComponent(keyId)}`, ADMIN_ENDPOINTS.anthropic);
  const body = await getJson(doFetch, url, headers(adminKey));
  return typeof body["status"] === "string" ? body["status"] : "unknown";
}

/** The ids of a workspace's keys that work now: what pausing a workspace means. */
export async function activeWorkspaceKeys(doFetch: typeof fetch, adminKey: string, workspaceId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = new URL("/v1/organizations/api_keys", ADMIN_ENDPOINTS.anthropic);
    url.searchParams.set("workspace_id", workspaceId);
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "100");
    if (after !== undefined) url.searchParams.set("after_id", after);
    const body = await getJson(doFetch, url, headers(adminKey));
    const data = Array.isArray(body["data"]) ? (body["data"] as Record<string, unknown>[]) : [];
    for (const item of data) if (typeof item?.["id"] === "string" && item["status"] === "active") ids.push(item["id"]);
    const last = body["last_id"];
    if (body["has_more"] !== true || typeof last !== "string" || last === "") return ids;
    after = last;
  }
  throw new Error("the workspace has more keys than CostGrid will pause at once");
}
