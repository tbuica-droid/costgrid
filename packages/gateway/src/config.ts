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
   * The upstream provider credential. Held by the gateway, never by the
   * calling service — that indirection is the point of a gateway: a leaked
   * client key can be revoked in CostGrid without rotating the provider key.
   */
  readonly anthropicApiKey: string;
  readonly anthropicBaseUrl: string;
  /** Upstream request timeout. Long, because a max-effort call legitimately takes minutes. */
  readonly upstreamTimeoutMs: number;
  /**
   * When true, a request presenting no valid CostGrid key is attributed to the
   * single local tenant instead of being rejected. For solo/self-hosted use;
   * must stay false in any multi-tenant deployment.
   */
  readonly allowAnonymous: boolean;
  readonly logLevel: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${name} is not set. The gateway cannot forward requests without an upstream credential.`,
    );
  }
  return value.trim();
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

export function loadConfig(): GatewayConfig {
  return {
    port: integer("COSTGRID_PORT", 8787),
    host: process.env["COSTGRID_HOST"]?.trim() || "127.0.0.1",
    databasePath: process.env["COSTGRID_DB"]?.trim() || "./costgrid.db",
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    anthropicBaseUrl: process.env["ANTHROPIC_BASE_URL"]?.trim() || "https://api.anthropic.com",
    upstreamTimeoutMs: integer("COSTGRID_UPSTREAM_TIMEOUT_MS", 15 * 60 * 1000),
    allowAnonymous: boolean("COSTGRID_ALLOW_ANONYMOUS", false),
    logLevel: process.env["COSTGRID_LOG_LEVEL"]?.trim() || "info",
  };
}
