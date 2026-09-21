import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, maskSecret } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Single sign-on, stored.
 *
 * The protocol itself lives in the gateway, because it needs the network. This
 * is the part that needs the database: which organisation trusts which
 * identity provider, which email domains that trust covers, and the short
 * lived state that makes a sign-in safe to complete.
 *
 * ## Why email domains are the boundary
 *
 * An identity provider will issue a valid token for anybody in its directory,
 * and it is the same provider for thousands of organisations. A token proves
 * the person is who they say; it does not prove they belong here. Without a
 * domain list, an organisation configuring a connection against a shared
 * issuer would admit that issuer's entire population. The list is what turns
 * "this token is genuine" into "this person is ours".
 */

export interface SsoConnection {
  readonly tenantId: string;
  readonly issuer: string;
  readonly clientId: string;
  /** Masked tail of the client secret, safe to show. */
  readonly secretHint: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly emailDomains: readonly string[];
  /** Give a matching address an account on first sign-in. */
  readonly autoProvision: boolean;
  /** Refuse password login for addresses in `emailDomains`. */
  readonly enforced: boolean;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

export interface SsoConnectionInput {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly emailDomains: readonly string[];
  readonly autoProvision?: boolean | undefined;
  readonly enforced?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

export interface PendingSsoRequest {
  readonly state: string;
  readonly tenantId: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * How long a sign-in may take between leaving here and coming back.
 *
 * Ten minutes is long enough for a password, a second factor and a consent
 * screen, and short enough that an intercepted redirect is rarely still
 * usable.
 */
export const SSO_REQUEST_TTL_MS = 10 * 60 * 1000;

interface ConnectionRow {
  readonly tenantId: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly secretHint: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly emailDomains: string;
  readonly autoProvision: number;
  readonly enforced: number;
  readonly enabled: number;
  readonly updatedAt: number;
}

const SELECT_CONNECTION = `
  SELECT tenant_id AS tenantId, issuer, client_id AS clientId, secret_hint AS secretHint,
         authorize_url AS authorizeUrl, token_url AS tokenUrl, jwks_url AS jwksUrl,
         email_domains AS emailDomains, auto_provision AS autoProvision,
         enforced, enabled, updated_at AS updatedAt
  FROM sso_connections`;

function toConnection(row: ConnectionRow): SsoConnection {
  return {
    tenantId: row.tenantId,
    issuer: row.issuer,
    clientId: row.clientId,
    secretHint: row.secretHint,
    authorizeUrl: row.authorizeUrl,
    tokenUrl: row.tokenUrl,
    jwksUrl: row.jwksUrl,
    emailDomains: row.emailDomains === "" ? [] : row.emailDomains.split(","),
    autoProvision: row.autoProvision === 1,
    enforced: row.enforced === 1,
    enabled: row.enabled === 1,
    updatedAt: row.updatedAt,
  };
}

/** The part of an address after the `@`, lower-cased, or undefined. */
export function domainOf(email: string): string | undefined {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  return email.slice(at + 1).trim().toLowerCase();
}

function normaliseDomains(domains: readonly string[]): string {
  const cleaned = domains
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d !== "");
  for (const domain of cleaned) {
    // A comma would split one domain into two entries and widen the list
    // silently, which is the one validation failure here that grants access.
    if (domain.includes(",")) throw new RangeError("a domain may not contain a comma");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      throw new RangeError(`not a valid email domain: ${domain}`);
    }
  }
  if (cleaned.length === 0) throw new RangeError("at least one email domain is required");
  return [...new Set(cleaned)].sort().join(",");
}

export class SsoRepository {
  readonly #db: Db;
  readonly #masterKey: Buffer;

  constructor(db: Db, masterKey: Buffer) {
    this.#db = db;
    this.#masterKey = masterKey;
  }

  get(tenantId: string): SsoConnection | undefined {
    const row = this.#db
      .prepare(`${SELECT_CONNECTION} WHERE tenant_id = ?`)
      .get(tenantId) as ConnectionRow | undefined;
    return row ? toConnection(row) : undefined;
  }

  put(tenantId: string, input: SsoConnectionInput, now = Date.now()): SsoConnection {
    const domains = normaliseDomains(input.emailDomains);
    if (input.clientSecret.trim() === "") throw new RangeError("client secret is required");

    // Every URL is https and absolute. A http token endpoint would send the
    // client secret in clear text; a http authorize endpoint would send the
    // user somewhere a network attacker chose.
    for (const [field, value] of [
      ["issuer", input.issuer],
      ["authorizeUrl", input.authorizeUrl],
      ["tokenUrl", input.tokenUrl],
      ["jwksUrl", input.jwksUrl],
    ] as const) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new RangeError(`${field} is not a valid URL`);
      }
      if (parsed.protocol !== "https:") throw new RangeError(`${field} must be https`);
    }

    const encrypted = encryptSecret(input.clientSecret, this.#masterKey);
    const hint = maskSecret(input.clientSecret);

    this.#db
      .prepare(
        `INSERT INTO sso_connections
           (tenant_id, issuer, client_id, encrypted_secret, secret_hint,
            authorize_url, token_url, jwks_url, email_domains,
            auto_provision, enforced, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET
           issuer           = excluded.issuer,
           client_id        = excluded.client_id,
           encrypted_secret = excluded.encrypted_secret,
           secret_hint      = excluded.secret_hint,
           authorize_url    = excluded.authorize_url,
           token_url        = excluded.token_url,
           jwks_url         = excluded.jwks_url,
           email_domains    = excluded.email_domains,
           auto_provision   = excluded.auto_provision,
           enforced         = excluded.enforced,
           enabled          = excluded.enabled,
           updated_at       = excluded.updated_at`,
      )
      .run(
        tenantId,
        input.issuer,
        input.clientId,
        encrypted,
        hint,
        input.authorizeUrl,
        input.tokenUrl,
        input.jwksUrl,
        domains,
        input.autoProvision === false ? 0 : 1,
        input.enforced === true ? 1 : 0,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    return this.get(tenantId)!;
  }

  delete(tenantId: string): void {
    this.#db.prepare("DELETE FROM sso_connections WHERE tenant_id = ?").run(tenantId);
  }

  /** The client secret in plaintext, for the token exchange and nothing else. */
  revealSecret(tenantId: string): string | undefined {
    const row = this.#db
      .prepare("SELECT encrypted_secret AS encryptedSecret FROM sso_connections WHERE tenant_id = ?")
      .get(tenantId) as { encryptedSecret: string } | undefined;
    return row ? decryptSecret(row.encryptedSecret, this.#masterKey) : undefined;
  }

  /**
   * The enabled connection governing an address, if any.
   *
   * Used two ways: to offer single sign-on to someone typing a work address,
   * and to refuse a password to someone whose organisation has enforced it.
   */
  forEmail(email: string): SsoConnection | undefined {
    const domain = domainOf(email);
    if (domain === undefined) return undefined;

    const row = this.#db
      .prepare(
        `${SELECT_CONNECTION}
         WHERE enabled = 1
           AND (',' || email_domains || ',') LIKE ('%,' || ? || ',%')
         ORDER BY tenant_id LIMIT 1`,
      )
      .get(domain) as ConnectionRow | undefined;
    return row ? toConnection(row) : undefined;
  }

  // ------------------------------------------------------- in-flight state

  /**
   * Record a sign-in about to start.
   *
   * The three secrets stored here each close a different hole: `state` proves
   * the callback answers a request this server made, `nonce` proves the token
   * answers this request rather than a replayed one, and `codeVerifier` proves
   * whoever redeems the code is whoever asked for it.
   */
  beginRequest(
    tenantId: string,
    fields: { state: string; nonce: string; codeVerifier: string; redirectUri: string },
    now = Date.now(),
  ): void {
    this.#db
      .prepare(
        `INSERT INTO sso_requests
           (state, tenant_id, nonce, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.state,
        tenantId,
        fields.nonce,
        fields.codeVerifier,
        fields.redirectUri,
        now,
        now + SSO_REQUEST_TTL_MS,
      );
  }

  /**
   * Take a pending request, once.
   *
   * Deleting as part of the read is the point: a code that arrives twice is
   * either a replay or a bug, and either way the second attempt must find
   * nothing.
   */
  consumeRequest(state: string, now = Date.now()): PendingSsoRequest | undefined {
    return this.#db.transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT state, tenant_id AS tenantId, nonce, code_verifier AS codeVerifier,
                  redirect_uri AS redirectUri, expires_at AS expiresAt
           FROM sso_requests WHERE state = ?`,
        )
        .get(state) as (PendingSsoRequest & { expiresAt: number }) | undefined;

      if (!row) return undefined;
      this.#db.prepare("DELETE FROM sso_requests WHERE state = ?").run(state);
      if (row.expiresAt <= now) return undefined;

      return {
        state: row.state,
        tenantId: row.tenantId,
        nonce: row.nonce,
        codeVerifier: row.codeVerifier,
        redirectUri: row.redirectUri,
      };
    })();
  }

  purgeExpiredRequests(now = Date.now()): number {
    return this.#db.prepare("DELETE FROM sso_requests WHERE expires_at <= ?").run(now).changes;
  }

  /**
   * Find or create the account behind a verified identity, and put them in the
   * organisation.
   *
   * The password hash of a provisioned account is a random value that has
   * never existed anywhere else, so a password login against it cannot
   * succeed. That is a stronger guarantee than a nullable column and a check
   * somebody has to remember to write.
   */
  provision(
    connection: SsoConnection,
    identity: { email: string; name: string },
    hashPassword: (value: string) => string,
    now = Date.now(),
  ): { userId: string; created: boolean } {
    const email = identity.email.trim().toLowerCase();
    const domain = domainOf(email);
    if (domain === undefined || !connection.emailDomains.includes(domain)) {
      throw new RangeError(`${email} is not in a domain this connection covers`);
    }

    return this.#db.transaction(() => {
      const existing = this.#db
        .prepare("SELECT id FROM users WHERE email = ?")
        .get(email) as { id: string } | undefined;

      if (existing) {
        // An existing member signing in through a new route is not a new
        // member. Their role is whatever it already was.
        this.#db
          .prepare(
            `INSERT INTO memberships (user_id, tenant_id, role, created_at)
             VALUES (?, ?, 'member', ?)
             ON CONFLICT (user_id, tenant_id) DO NOTHING`,
          )
          .run(existing.id, connection.tenantId, now);
        this.#db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, existing.id);
        return { userId: existing.id, created: false };
      }

      if (!connection.autoProvision) {
        throw new RangeError("no account for that address, and this connection does not create one");
      }

      const userId = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO users (id, email, name, password_hash, created_at, last_login_at, auth_source)
           VALUES (?, ?, ?, ?, ?, ?, 'sso')`,
        )
        .run(
          userId,
          email,
          identity.name.trim() === "" ? email : identity.name.trim(),
          hashPassword(randomUUID() + randomUUID()),
          now,
          now,
        );
      this.#db
        .prepare(
          "INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'member', ?)",
        )
        .run(userId, connection.tenantId, now);

      return { userId, created: true };
    })();
  }
}
