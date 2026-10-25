import type { KeyFact, KeyStatus, Provider } from "@costgrid/core";
import { ADMIN_ENDPOINTS, getJson } from "./index.js";

/**
 * The provider's own names for the keys, workspaces and projects a usage
 * report identifies only by id, and what the same key lists say about each
 * key for the key-safety warnings: status, when it was made, when it was last
 * used, whose it is, and whether it is in Claude's Default workspace.
 *
 * "key_7Hq…" means nothing to an owner; "support-bot" does. Metadata only: no
 * key material, no usage, nothing the admin key could also be used to change.
 *
 * Best effort by design. A key without permission to list keys, a provider
 * outage or an unexpected response shape all return an empty map, and the
 * console falls back to showing ids, with no key facts. Nothing here throws, and nothing here
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
): Promise<Record<string, unknown>[] & { complete?: boolean }> {
  const items: Record<string, unknown>[] & { complete?: boolean } = [];
  items.complete = false;
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
    if (body["has_more"] !== true || typeof last !== "string" || last === "") {
      items.complete = true;
      break;
    }
    after = last;
  }
  // `complete` stays false past MAX_PAGES: a partial list must not stand for the whole.
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

export interface SourceDirectory {
  readonly labels: ReadonlyMap<string, string>;
  /** Null when the key lists could not be read, so what is already known is kept. */
  readonly keys: readonly KeyFact[] | null;
}

const STATUSES: readonly KeyStatus[] = ["active", "inactive", "archived"];
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const name = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/** RFC 3339 (Claude) or Unix seconds (OpenAI) to epoch ms; null for anything else. */
function timeOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v * 1000;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function anthropicKey(item: Record<string, unknown>): KeyFact | null {
  const id = str(item["id"]);
  if (id === null) return null;
  const status = STATUSES.find((s) => s === item["status"]) ?? "unknown";
  return {
    provider: "anthropic",
    id,
    label: name(item["name"]),
    status,
    createdAt: timeOf(item["created_at"]),
    lastUsedAt: null,
    ownerKind: null,
    // The Default workspace has no id: its keys carry workspace_id null.
    defaultWorkspace: "workspace_id" in item ? item["workspace_id"] === null : null,
  };
}

function openaiKey(item: Record<string, unknown>, projectArchived: boolean): KeyFact | null {
  const id = str(item["id"]);
  if (id === null) return null;
  const owner = item["owner"];
  const type = typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>)["type"] : undefined;
  return {
    provider: "openai",
    id,
    label: name(item["name"]),
    // A live project's key list holds only keys that work; an archived project's keys do not.
    status: projectArchived ? "archived" : "active",
    createdAt: timeOf(item["created_at"]),
    lastUsedAt: timeOf(item["last_used_at"]),
    ownerKind: type === "user" ? "user" : type === "service_account" ? "service-account" : null,
    defaultWorkspace: null,
  };
}

async function anthropicDirectory(doFetch: Fetch, adminKey: string): Promise<SourceDirectory> {
  const headers = { "x-api-key": adminKey, "anthropic-version": "2023-06-01" };
  const labels = new Map<string, string>();
  const workspaces = new URL("/v1/organizations/workspaces", ADMIN_ENDPOINTS.anthropic);
  // Archived workspaces still own usage from before they were archived.
  workspaces.searchParams.set("include_archived", "true");
  collect(labels, await listAll(doFetch, workspaces, headers, "after_id"));
  const keysUrl = new URL("/v1/organizations/api_keys", ADMIN_ENDPOINTS.anthropic);
  const items = await listAll(doFetch, keysUrl, headers, "after_id");
  collect(labels, items);
  return { labels, keys: items.complete ? items.map(anthropicKey).filter((k) => k !== null) : null };
}

async function openaiDirectory(doFetch: Fetch, adminKey: string): Promise<SourceDirectory> {
  const headers = { authorization: `Bearer ${adminKey}` };
  const labels = new Map<string, string>();
  const projectsUrl = new URL("/v1/organization/projects", ADMIN_ENDPOINTS.openai);
  projectsUrl.searchParams.set("include_archived", "true");
  const projects = await listAll(doFetch, projectsUrl, headers, "after");
  collect(labels, projects);

  const keys: KeyFact[] = [];
  let complete = projects.complete === true && projects.length <= MAX_PROJECTS;
  for (const project of projects.slice(0, MAX_PROJECTS)) {
    const id = project["id"];
    if (typeof id !== "string" || id === "") continue;
    const keysUrl = new URL(
      `/v1/organization/projects/${encodeURIComponent(id)}/api_keys`,
      ADMIN_ENDPOINTS.openai,
    );
    const items = await listAll(doFetch, keysUrl, headers, "after");
    collect(labels, items);
    complete &&= items.complete === true;
    for (const item of items) {
      const fact = openaiKey(item, project["status"] === "archived");
      if (fact !== null) keys.push(fact);
    }
  }
  // A partial list would drop real keys from what is kept, so it keeps nothing.
  return { labels, keys: complete ? keys : null };
}

const EMPTY: SourceDirectory = { labels: new Map(), keys: null };

/** Names and key facts for everything the admin key can list. Empty, with keys null, on any failure. */
export async function fetchSourceDirectory(
  provider: Provider,
  adminKey: string,
  fetchImpl: typeof fetch,
): Promise<SourceDirectory> {
  try {
    if (provider === "anthropic") return await anthropicDirectory(fetchImpl, adminKey);
    if (provider === "openai") return await openaiDirectory(fetchImpl, adminKey);
  } catch {
    // Deliberately silent. See the file comment.
  }
  return EMPTY;
}
