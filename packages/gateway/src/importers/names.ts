import type { Provider } from "@costgrid/core";
import { ADMIN_ENDPOINTS, getJson } from "./index.js";

/**
 * The provider's own names for the keys, workspaces and projects a usage
 * report identifies only by id.
 *
 * "key_7Hq…" means nothing to an owner; "support-bot" does. Names only: no
 * key material, no usage, nothing the admin key could also be used to change.
 *
 * Best effort by design. A key without permission to list keys, a provider
 * outage or an unexpected response shape all return an empty map, and the
 * console falls back to showing ids. Nothing here throws, and nothing here
 * logs, so the admin key cannot end up in an error message or a log line.
 */

/** Per list, so a hostile pager cannot keep a sync busy forever. */
const MAX_PAGES = 50;
/** OpenAI lists keys per project; an organisation past this is named in part. */
const MAX_PROJECTS = 200;

type Fetch = typeof fetch;
type Headers = Record<string, string>;

/**
 * Every `{id, name}` across the pages of a list endpoint.
 *
 * Both providers page with a cursor taken from the last id of the page:
 * Anthropic calls the parameter `after_id`, OpenAI `after`.
 */
async function listAll(
  doFetch: Fetch,
  base: URL,
  headers: Headers,
  cursorParam: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(base);
    url.searchParams.set("limit", "100");
    if (after !== undefined) url.searchParams.set(cursorParam, after);

    const body = await getJson(doFetch, url, headers);
    const data = body["data"];
    if (!Array.isArray(data)) throw new TypeError("list has no data array");
    for (const item of data) {
      if (typeof item === "object" && item !== null) items.push(item as Record<string, unknown>);
    }

    const last = body["last_id"];
    if (body["has_more"] !== true || typeof last !== "string" || last === "") break;
    after = last;
  }
  return items;
}

function collect(into: Map<string, string>, items: readonly Record<string, unknown>[]): void {
  for (const item of items) {
    const id = item["id"];
    const name = item["name"];
    if (typeof id === "string" && typeof name === "string" && id !== "" && name.trim() !== "") {
      into.set(id, name.trim());
    }
  }
}

async function anthropicLabels(doFetch: Fetch, adminKey: string): Promise<Map<string, string>> {
  const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01" };
  const labels = new Map<string, string>();
  const workspaces = new URL("/v1/organizations/workspaces", ADMIN_ENDPOINTS.anthropic);
  // Archived workspaces still own usage from before they were archived.
  workspaces.searchParams.set("include_archived", "true");
  collect(labels, await listAll(doFetch, workspaces, headers, "after_id"));
  const keys = new URL("/v1/organizations/api_keys", ADMIN_ENDPOINTS.anthropic);
  collect(labels, await listAll(doFetch, keys, headers, "after_id"));
  return labels;
}

async function openaiLabels(doFetch: Fetch, adminKey: string): Promise<Map<string, string>> {
  const headers = { authorization: `Bearer ${adminKey}` };
  const labels = new Map<string, string>();
  const projectsUrl = new URL("/v1/organization/projects", ADMIN_ENDPOINTS.openai);
  projectsUrl.searchParams.set("include_archived", "true");
  const projects = await listAll(doFetch, projectsUrl, headers, "after");
  collect(labels, projects);

  for (const project of projects.slice(0, MAX_PROJECTS)) {
    const id = project["id"];
    if (typeof id !== "string" || id === "") continue;
    const keysUrl = new URL(
      `/v1/organization/projects/${encodeURIComponent(id)}/api_keys`,
      ADMIN_ENDPOINTS.openai,
    );
    collect(labels, await listAll(doFetch, keysUrl, headers, "after"));
  }
  return labels;
}

/** Id to name, for every key, workspace or project the admin key can list. Empty on any failure. */
export async function fetchSourceLabels(
  provider: Provider,
  adminKey: string,
  fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
  try {
    if (provider === "anthropic") return await anthropicLabels(fetchImpl, adminKey);
    if (provider === "openai") return await openaiLabels(fetchImpl, adminKey);
  } catch {
    // Deliberately silent. See the file comment.
  }
  return new Map();
}
