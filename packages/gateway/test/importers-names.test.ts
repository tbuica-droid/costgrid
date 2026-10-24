import { describe, expect, it } from "vitest";
import { fetchSourceLabels } from "../src/importers/names.js";

/** Serves JSON by path and records every request, headers included. */
function routes(
  table: Record<string, unknown | ((url: URL) => unknown)>,
  seen: { url: URL; headers: Record<string, string> }[] = [],
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const entry = table[url.pathname];
    if (entry === undefined) return new Response("{}", { status: 404 });
    const body = typeof entry === "function" ? (entry as (u: URL) => unknown)(url) : entry;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("source names", () => {
  it("lists Claude workspaces and keys, following the after_id cursor", async () => {
    const seen: { url: URL; headers: Record<string, string> }[] = [];
    const doFetch = routes(
      {
        "/v1/organizations/workspaces": { data: [{ id: "wrkspc_1", name: "Support" }], has_more: false },
        "/v1/organizations/api_keys": (url: URL) =>
          url.searchParams.get("after_id") === "apikey_a"
            ? { data: [{ id: "apikey_b", name: "lead-scorer", workspace_id: null }], has_more: false }
            : {
                data: [{ id: "apikey_a", name: " support-bot ", workspace_id: "wrkspc_1" }],
                has_more: true,
                last_id: "apikey_a",
              },
      },
      seen,
    );

    const labels = await fetchSourceLabels("anthropic", "sk-ant-admin-x", doFetch);

    expect(Object.fromEntries(labels)).toEqual({
      wrkspc_1: "Support",
      apikey_a: "support-bot",
      apikey_b: "lead-scorer",
    });
    expect(seen.every((s) => s.headers["x-api-key"] === "sk-ant-admin-x")).toBe(true);
    expect(seen.every((s) => s.headers["anthropic-version"] === "2023-06-01")).toBe(true);
  });

  it("lists OpenAI projects and each project's keys, with Bearer auth", async () => {
    const seen: { url: URL; headers: Record<string, string> }[] = [];
    const doFetch = routes(
      {
        "/v1/organization/projects": {
          data: [
            { id: "proj_1", name: "Support" },
            { id: "proj_2", name: "Sales" },
          ],
          has_more: false,
        },
        "/v1/organization/projects/proj_1/api_keys": { data: [{ id: "key_1", name: "bot" }], has_more: false },
        "/v1/organization/projects/proj_2/api_keys": { data: [], has_more: false },
      },
      seen,
    );

    const labels = await fetchSourceLabels("openai", "sk-admin-x", doFetch);

    expect(Object.fromEntries(labels)).toEqual({ proj_1: "Support", proj_2: "Sales", key_1: "bot" });
    expect(seen.every((s) => s.headers["authorization"] === "Bearer sk-admin-x")).toBe(true);
  });

  it("returns nothing, and does not throw, when a lookup fails", async () => {
    const forbidden = (async () =>
      new Response(JSON.stringify({ error: { message: "insufficient permissions" } }), {
        status: 403,
      })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const garbage = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    for (const doFetch of [forbidden, offline, garbage]) {
      await expect(fetchSourceLabels("anthropic", "k", doFetch)).resolves.toEqual(new Map());
      await expect(fetchSourceLabels("openai", "k", doFetch)).resolves.toEqual(new Map());
    }
    await expect(fetchSourceLabels("bedrock", "k", forbidden)).resolves.toEqual(new Map());
  });
});
