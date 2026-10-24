/**
 * The same Claude key, seen two ways.
 *
 * A Claude usage file names keys and workspaces ("Support / support-bot");
 * the admin API identifies them (`apikey_…` in `wrkspc_…`) and only a lookup
 * gives their names. An owner who uploads a file one month and connects a key
 * the next would otherwise see the same key twice. Matching by name puts both
 * on the same agent.
 *
 * Names are not unique and can be renamed, so a pair is only made when it is
 * the only candidate on both sides. A key outside any workspace is left
 * alone: the file and the API describe the default workspace differently,
 * and that has not been checked against a real export.
 *
 * OpenAI needs none of this: its usage file carries the same ids as its API.
 */

export interface MatchableSource {
  readonly provider: string;
  readonly kind: string;
  readonly id: string;
  readonly parentId: string | null;
  /** The provider's name for it, looked up through the admin API. */
  readonly label: string | null;
  /** The provider's name for its workspace, looked up through the admin API. */
  readonly parentLabel: string | null;
}

/** What a usage file would have called this source, if it came from the admin API. */
function fileName(source: MatchableSource): string | undefined {
  if (source.label === null) return undefined;
  if (source.kind === "workspace") return source.label;
  if (source.kind === "key" && source.parentLabel !== null) return `${source.parentLabel} / ${source.label}`;
  return undefined;
}

/** Whether this source came from a usage file: its id is the names themselves. */
function fromFile(source: MatchableSource): boolean {
  if (source.kind === "workspace") return source.label === null;
  return source.kind === "key" && source.parentId !== null && source.id.startsWith(`${source.parentId} / `);
}

/** Pairs of sources that are the same Claude key or workspace: [from a file, from the admin API]. */
export function twins<T extends MatchableSource>(sources: readonly T[]): [T, T][] {
  const claude = sources.filter((s) => s.provider === "anthropic" && (s.kind === "key" || s.kind === "workspace"));
  const files = new Map<string, T[]>();
  const apis = new Map<string, T[]>();
  for (const source of claude) {
    const file = fromFile(source);
    const name = file ? source.id : fileName(source);
    if (name === undefined) continue;
    const bucket = file ? files : apis;
    const key = `${source.kind}\u0000${name}`;
    bucket.set(key, [...(bucket.get(key) ?? []), source]);
  }

  const pairs: [T, T][] = [];
  for (const [key, fromFiles] of files) {
    const fromApi = apis.get(key);
    if (fromFiles.length === 1 && fromApi?.length === 1) pairs.push([fromFiles[0]!, fromApi[0]!]);
  }
  return pairs;
}

/** The one source that is the same key as `source`, if there is exactly one. */
export function twinOf<T extends MatchableSource>(source: MatchableSource, sources: readonly T[]): T | undefined {
  const same = (a: MatchableSource): boolean =>
    a.provider === source.provider && a.kind === source.kind && a.id === source.id;
  for (const [file, api] of twins(sources)) {
    if (same(file)) return api;
    if (same(api)) return file;
  }
  return undefined;
}
