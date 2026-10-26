import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@costgrid/core";
import { validateWebhookUrl } from "@costgrid/db";
import { readMasterKey } from "./keychain.js";

/**
 * Gateway configuration, resolved from the environment at startup.
 *
 * Everything is validated here and nowhere else, so a misconfigured deploy
 * fails at boot with a clear message rather than on the first request.
 */
export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly databasePath: string;
  /**
   * Upstream credentials, one per provider that is enabled.
   *
   * Held by the gateway, never by the calling service — that indirection is
   * the point: a leaked client key can be revoked in CostGrid without rotating
   * the provider key. A provider absent from this map serves no route at all.
   */
  readonly providerKeys: Partial<Record<Provider, string>>;
  readonly providerBaseUrls: Partial<Record<Provider, string>>;
  /** Upstream request timeout. Long, because a max-effort call legitimately takes minutes. */
  readonly upstreamTimeoutMs: number;
  /**
   * Let adapters modify an outgoing request so the response carries usage.
   *
   * Only OpenAI needs this today (`stream_options.include_usage`), and only
   * when the caller did not set `stream_options` themselves. Turning it off
   * means streamed OpenAI calls record as unpriced — correct, but blind.
   */
  readonly injectUsageRequest: boolean;
  /**
   * Record tool *names* seen in requests and responses, for the topology view.
   *
   * Names only — never arguments, which are content. Off switches the whole
   * path, for anyone whose tool names are themselves sensitive.
   */
  readonly extractTools: boolean;
  /**
   * When true, a request presenting no valid CostGrid key is attributed to the
   * single local tenant instead of being rejected. For solo/self-hosted use;
   * must stay false in any multi-tenant deployment.
   */
  readonly allowAnonymous: boolean;
  /**
   * Hosted mode: tenants sign up, bring their own provider credentials, and
   * are billed. Enables the control plane and requires COSTGRID_MASTER_KEY.
   *
   * In self-hosted mode the operator's env-var keys serve everyone, which is
   * exactly right for one organisation and exactly wrong for many.
   */
  readonly hosted: boolean;
  /**
   * Desktop mode: one person, one computer. Hosted mode's control plane, so
   * provider keys are entered in the console and encrypted rather than read
   * from `.env`, but with exactly one account, which signup creates on first
   * run and then closes behind it. Binds to this machine only.
   */
  readonly desktop: boolean;
  /** Secret used to derive the key that encrypts tenants' provider credentials. */
  readonly masterKeySecret: string | undefined;
  /** Where the master key came from, for the boot log. Never the key itself. */
  readonly masterKeySource: "env" | "keychain";
  /** Set Secure on session cookies. Must be true behind TLS; false breaks local http. */
  readonly secureCookies: boolean;
  /**
   * The address browsers reach this deployment at, with no trailing slash.
   *
   * Single sign-on needs it: the redirect a customer registers with their
   * identity provider must match the one sent on every sign-in, byte for byte.
   * Left unset, it is taken from the request, which works but leaves the
   * matching to whatever Host header arrived. Set it in any real deployment.
   */
  readonly publicUrl: string | undefined;
  /**
   * Where to send the audit log's fingerprint, and what to sign it with.
   *
   * Anchoring is off unless both are set. It is the difference between a hash
   * chain that somebody could check and one a separate system is already
   * checking, so it is worth switching on, but it needs somewhere to send to
   * and turning it on by default would invent that destination.
   */
  readonly anchorUrl: string | undefined;
  readonly anchorKey: string | undefined;
  /** Minutes between anchors. A heartbeat, so silence is itself a signal. */
  readonly anchorIntervalMinutes: number;
  readonly logLevel: string;
  /**
   * Write the log to a file instead of standard output.
   *
   * The desktop app has no terminal to print to, so its log goes next to its
   * database, where a person asking for help can find it.
   */
  readonly logFile: string | undefined;
  /**
   * Where alerts go when there are no accounts to store an address in: a
   * self-hosted gateway. Hosted and desktop installs set it in the console,
   * where it is encrypted at rest. Optional so a config written before alerts
   * existed still type-checks.
   */
  readonly alertWebhookUrl?: string | undefined;
  /**
   * Which proxies may tell the gateway the client's protocol, host and
   * address (`X-Forwarded-*`), in Fastify's `trustProxy` form: true for any,
   * or a comma-separated list of addresses or CIDR ranges.
   *
   * Off by default, because a gateway reachable directly would otherwise
   * believe whatever a client wrote in those headers. A hosted deployment
   * behind its TLS proxy sets it, and then redirects plain http to https.
   */
  readonly trustProxy?: boolean | string | undefined;
}

/**
 * A provider base URL from the environment. The provider key is sent to it on
 * every call, so it must be https; plain http is allowed only to this machine,
 * for a local mock or a tunnel.
 */
function providerBaseUrl(name: string): string | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL, got ${JSON.stringify(raw)}`);
  }
  const loopback = LOOPBACK.has(parsed.hostname.replace(/^\[|\]$/g, ""));
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${name} must be https (http is allowed only for localhost), got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function trustProxy(): boolean | string | undefined {
  const raw = optional("COSTGRID_TRUST_PROXY");
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  return raw;
}

function publicUrl(): string | undefined {
  const raw = process.env["COSTGRID_PUBLIC_URL"];
  if (raw === undefined || raw.trim() === "") return undefined;

  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`COSTGRID_PUBLIC_URL is not a valid URL, got ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("COSTGRID_PUBLIC_URL must be https outside local development");
  }
  return trimmed;
}

function anchorUrl(): string | undefined {
  const raw = process.env["COSTGRID_ANCHOR_URL"];
  if (raw === undefined || raw.trim() === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`COSTGRID_ANCHOR_URL is not a valid URL, got ${JSON.stringify(raw)}`);
  }
  // An anchor is evidence in transit. Sending it in clear text would let
  // anyone on the path drop or alter it, which is the whole thing it guards.
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error("COSTGRID_ANCHOR_URL must be https outside local development");
  }
  return parsed.toString();
}

function alertWebhookUrl(): string | undefined {
  const raw = process.env["COSTGRID_ALERT_WEBHOOK"];
  if (raw === undefined || raw.trim() === "") return undefined;
  try {
    return validateWebhookUrl(raw);
  } catch (error) {
    throw new Error(`COSTGRID_ALERT_WEBHOOK: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}`);
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The per-user application data folder, the same one an Electron app is given. */
export function appDataDir(platform = process.platform): string {
  const home = homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return process.env["APPDATA"] ?? join(home, "AppData", "Roaming");
  return process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
}

export interface ConfigDeps {
  /** Overridable so tests never touch a real keychain. */
  readonly readKeychain?: () => string | undefined;
}

export function loadConfig(deps: ConfigDeps = {}): GatewayConfig {
  const providerKeys: Partial<Record<Provider, string>> = {};
  const providerBaseUrls: Partial<Record<Provider, string>> = {};

  const anthropicKey = optional("ANTHROPIC_API_KEY");
  if (anthropicKey !== undefined) providerKeys.anthropic = anthropicKey;
  const anthropicBase = providerBaseUrl("ANTHROPIC_BASE_URL");
  if (anthropicBase !== undefined) providerBaseUrls.anthropic = anthropicBase;

  const openaiKey = optional("OPENAI_API_KEY");
  if (openaiKey !== undefined) providerKeys.openai = openaiKey;
  const openaiBase = providerBaseUrl("OPENAI_BASE_URL");
  if (openaiBase !== undefined) providerBaseUrls.openai = openaiBase;

  /*
   * Bedrock takes one compound credential rather than four env vars, so a
   * single secret rotates atomically — half-rotated AWS keys are a classic
   * way to take an integration down.
   */
  const bedrockKey = optional("AWS_BEDROCK_CREDENTIAL");
  if (bedrockKey !== undefined) providerKeys.bedrock = bedrockKey;
  const bedrockBase = providerBaseUrl("AWS_BEDROCK_BASE_URL");
  if (bedrockBase !== undefined) {
    providerBaseUrls.bedrock = bedrockBase;
  } else if (bedrockKey !== undefined) {
    // The runtime endpoint is regional, and the region is already in the
    // credential. Deriving it beats asking for the same fact twice.
    const region = bedrockKey.split(":")[2];
    if (region) providerBaseUrls.bedrock = `https://bedrock-runtime.${region}.amazonaws.com`;
  }

  const vertexKey = optional("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (vertexKey !== undefined) providerKeys.vertex = vertexKey;
  const vertexBase = providerBaseUrl("GOOGLE_VERTEX_BASE_URL");
  if (vertexBase !== undefined) {
    providerBaseUrls.vertex = vertexBase;
  } else if (vertexKey !== undefined) {
    const location = optional("GOOGLE_CLOUD_LOCATION") ?? "us-east5";
    providerBaseUrls.vertex = `https://${location}-aiplatform.googleapis.com`;
  }

  const desktop = boolean("COSTGRID_DESKTOP", false);
  const hosted = boolean("COSTGRID_HOSTED", desktop);
  if (desktop && !hosted) {
    throw new Error(
      "COSTGRID_DESKTOP=true runs the hosted control plane for one person; " +
        "it cannot be combined with COSTGRID_HOSTED=false.",
    );
  }

  const host = process.env["COSTGRID_HOST"]?.trim() || "127.0.0.1";
  if (desktop && !LOOPBACK.has(host)) {
    throw new Error(
      `COSTGRID_DESKTOP serves the console where your provider keys are stored, so it only ` +
        `listens on this machine. COSTGRID_HOST must be 127.0.0.1, ::1 or localhost, got ${JSON.stringify(host)}.`,
    );
  }

  const source = (optional("COSTGRID_MASTER_KEY_SOURCE")?.toLowerCase() ??
    (desktop ? "keychain" : "env")) as string;
  if (source !== "env" && source !== "keychain") {
    throw new Error(`COSTGRID_MASTER_KEY_SOURCE must be env or keychain, got ${JSON.stringify(source)}`);
  }
  // Two places the key could come from is how a deploy ends up encrypting with
  // one and decrypting with the other, which loses every stored credential.
  if (source === "keychain" && optional("COSTGRID_MASTER_KEY") !== undefined) {
    throw new Error(
      "COSTGRID_MASTER_KEY is set, but the master key source is the keychain. " +
        "Use one or the other: unset COSTGRID_MASTER_KEY, or set COSTGRID_MASTER_KEY_SOURCE=env.",
    );
  }

  const masterKeySecret =
    source === "keychain"
      ? (deps.readKeychain ?? (() => readMasterKey()))()
      : optional("COSTGRID_MASTER_KEY");

  if (source === "keychain" && masterKeySecret === undefined) {
    throw new Error(
      "There is no CostGrid master key in your keychain yet. Create one, once, with: npm run desktop:init",
    );
  }

  if (hosted && masterKeySecret === undefined) {
    throw new Error(
      "COSTGRID_HOSTED=true requires COSTGRID_MASTER_KEY — tenants' provider keys " +
        "cannot be encrypted without it. Generate one with: openssl rand -base64 48",
    );
  }

  // Self-hosted mode meters nothing without an operator credential. Hosted
  // mode does not need one: every tenant brings their own.
  if (!hosted && Object.keys(providerKeys).length === 0) {
    throw new Error(
      "No provider credentials configured. Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY, " +
        "or set COSTGRID_HOSTED=true to let tenants supply their own.",
    );
  }

  if (hosted && boolean("COSTGRID_ALLOW_ANONYMOUS", false)) {
    throw new Error(
      "COSTGRID_ALLOW_ANONYMOUS cannot be true in hosted mode — it would attribute " +
        "every unauthenticated call to a single shared tenant.",
    );
  }

  return {
    hosted,
    desktop,
    masterKeySecret,
    masterKeySource: source,
    // Desktop mode is plain http on loopback, where a Secure cookie is either
    // refused or pointless: nothing on the wire leaves the machine.
    secureCookies: boolean("COSTGRID_SECURE_COOKIES", hosted && !desktop),
    publicUrl: publicUrl(),
    anchorUrl: anchorUrl(),
    anchorKey: optional("COSTGRID_ANCHOR_KEY"),
    anchorIntervalMinutes: integer("COSTGRID_ANCHOR_INTERVAL_MINUTES", 60),
    port: integer("COSTGRID_PORT", 8787),
    host,
    // The desktop database lives with the app's other data, not in whatever
    // folder the gateway happened to be started from.
    databasePath:
      process.env["COSTGRID_DB"]?.trim() ||
      (desktop ? join(appDataDir(), "CostGrid", "costgrid.db") : "./costgrid.db"),
    providerKeys,
    providerBaseUrls,
    upstreamTimeoutMs: integer("COSTGRID_UPSTREAM_TIMEOUT_MS", 15 * 60 * 1000),
    injectUsageRequest: boolean("COSTGRID_OPENAI_INJECT_USAGE", true),
    extractTools: boolean("COSTGRID_EXTRACT_TOOLS", true),
    allowAnonymous: boolean("COSTGRID_ALLOW_ANONYMOUS", false),
    logLevel: process.env["COSTGRID_LOG_LEVEL"]?.trim() || "info",
    logFile: optional("COSTGRID_LOG_FILE"),
    alertWebhookUrl: alertWebhookUrl(),
    trustProxy: trustProxy(),
  };
}
