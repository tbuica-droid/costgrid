import { randomUUID } from "node:crypto";
import {
  decryptSecret,
  encryptSecret,
  generateSessionToken,
  hashPassword,
  hashToken,
  isPlanId,
  maskSecret,
  type PlanId,
  type Provider,
  verifyPassword,
} from "@costgrid/core";
import type { Db } from "./database.js";

export type Role = "owner" | "member";

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface Membership {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly role: Role;
}

export interface AuthenticatedSession {
  readonly user: User;
  readonly sessionId: string;
  readonly expiresAt: number;
}

export interface StoredCredential {
  readonly provider: Provider;
  /** Masked tail, safe to display. The key itself is never returned by this type. */
  readonly hint: string;
  readonly baseUrl: string | undefined;
  readonly updatedAt: number;
}

/** How long a session lasts without re-authentication. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Accounts, sessions, per-tenant provider credentials and subscriptions.
 *
 * Separate from `CostGridRepository` because this is the control plane: it
 * runs on human-facing requests, not the metering path, and it is the only
 * place that touches decryptable secrets.
 */
export class AccountsRepository {
  readonly #db: Db;
  /** Derived once at startup from COSTGRID_MASTER_KEY; never persisted. */
  readonly #masterKey: Buffer;

  constructor(db: Db, masterKey: Buffer) {
    this.#db = db;
    this.#masterKey = masterKey;
  }

  // ------------------------------------------------------------------ users

  /**
   * Create a user and their first tenant, atomically.
   *
   * Signup is one transaction because a user with no tenant has nowhere to
   * put anything and a tenant with no owner cannot be administered — a
   * half-completed signup is worse than a failed one.
   */
  signUp(input: {
    email: string;
    name: string;
    password: string;
    organisation: string;
    plan?: PlanId;
  }): { user: User; tenantId: string } {
    const email = normalizeEmail(input.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new RangeError("not a valid email address");
    }
    if (input.name.trim() === "") throw new RangeError("name is required");
    if (input.organisation.trim() === "") throw new RangeError("organisation is required");

    // hashPassword enforces the length floor and throws before anything is written.
    const passwordHash = hashPassword(input.password);
    const plan: PlanId = input.plan ?? "free";
    const now = Date.now();
    const userId = randomUUID();
    const tenantId = randomUUID();

    this.#db.transaction(() => {
      if (this.findUserByEmail(email)) {
        throw new Error("an account with that email already exists");
      }
      this.#db
        .prepare(
          `INSERT INTO users (id, email, name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(userId, email, input.name.trim(), passwordHash, now);
      this.#db
        .prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)")
        .run(tenantId, input.organisation.trim(), now);
      this.#db
        .prepare(
          "INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
        )
        .run(userId, tenantId, now);
      this.#db
        .prepare(
          "INSERT INTO subscriptions (tenant_id, plan, started_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(tenantId, plan, now, now);
    })();

    return { user: { id: userId, email, name: input.name.trim(), createdAt: now }, tenantId };
  }

  findUserByEmail(email: string): (User & { passwordHash: string }) | undefined {
    return this.#db
      .prepare(
        `SELECT id, email, name, password_hash AS passwordHash, created_at AS createdAt
         FROM users WHERE email = ?`,
      )
      .get(normalizeEmail(email)) as (User & { passwordHash: string }) | undefined;
  }

  /**
   * Verify credentials.
   *
   * A missing account still runs a password verification against a dummy hash
   * so the response time does not reveal whether the email is registered.
   */
  authenticate(email: string, password: string): User | undefined {
    const record = this.findUserByEmail(email);
    if (!record) {
      verifyPassword(password, DUMMY_PASSWORD_HASH);
      return undefined;
    }
    if (!verifyPassword(password, record.passwordHash)) return undefined;

    this.#db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), record.id);
    return { id: record.id, email: record.email, name: record.name, createdAt: record.createdAt };
  }

  // --------------------------------------------------------------- sessions

  /** Start a session. The plaintext token is returned once and never stored. */
  createSession(userId: string, ttlMs = SESSION_TTL_MS): { token: string; expiresAt: number } {
    const { token, hash } = generateSessionToken();
    const now = Date.now();
    const expiresAt = now + ttlMs;

    this.#db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), userId, hash, now, expiresAt);

    return { token, expiresAt };
  }

  resolveSession(token: string, now = Date.now()): AuthenticatedSession | undefined {
    const row = this.#db
      .prepare(
        `SELECT s.id AS sessionId, s.expires_at AS expiresAt,
                u.id, u.email, u.name, u.created_at AS createdAt
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      )
      .get(hashToken(token), now) as
      | (User & { sessionId: string; expiresAt: number })
      | undefined;

    if (!row) return undefined;
    return {
      user: { id: row.id, email: row.email, name: row.name, createdAt: row.createdAt },
      sessionId: row.sessionId,
      expiresAt: row.expiresAt,
    };
  }

  revokeSession(token: string): void {
    this.#db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .run(Date.now(), hashToken(token));
  }

  /** Housekeeping: drop sessions that can no longer authenticate anything. */
  purgeExpiredSessions(now = Date.now()): number {
    return this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes;
  }

  // ------------------------------------------------------------ memberships

  membershipsOf(userId: string): Membership[] {
    return this.#db
      .prepare(
        `SELECT m.tenant_id AS tenantId, t.name AS tenantName, m.role
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = ?
         ORDER BY m.created_at`,
      )
      .all(userId) as Membership[];
  }

  /**
   * The user's role in a tenant, or undefined if they are not a member.
   *
   * Every control-plane route calls this rather than trusting a tenant id
   * from the request — otherwise any authenticated user could administer any
   * tenant by guessing an id.
   */
  roleIn(userId: string, tenantId: string): Role | undefined {
    const row = this.#db
      .prepare("SELECT role FROM memberships WHERE user_id = ? AND tenant_id = ?")
      .get(userId, tenantId) as { role: Role } | undefined;
    return row?.role;
  }

  addMember(tenantId: string, userId: string, role: Role): void {
    this.#db
      .prepare(
        `INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = excluded.role`,
      )
      .run(userId, tenantId, role, Date.now());
  }

  // --------------------------------------------------- provider credentials

  /** Store or replace a tenant's provider key, encrypted at rest. */
  putCredential(
    tenantId: string,
    provider: Provider,
    apiKey: string,
    baseUrl?: string,
  ): StoredCredential {
    if (apiKey.trim() === "") throw new RangeError("api key is required");

    const now = Date.now();
    const encrypted = encryptSecret(apiKey, this.#masterKey);
    const hint = maskSecret(apiKey);

    this.#db
      .prepare(
        `INSERT INTO provider_credentials
           (tenant_id, provider, encrypted_key, secret_hint, base_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, provider) DO UPDATE SET
           encrypted_key = excluded.encrypted_key,
           secret_hint   = excluded.secret_hint,
           base_url      = excluded.base_url,
           updated_at    = excluded.updated_at`,
      )
      .run(tenantId, provider, encrypted, hint, baseUrl ?? null, now, now);

    return { provider, hint, baseUrl, updatedAt: now };
  }

  /** Credentials a tenant has configured, without the secrets themselves. */
  listCredentials(tenantId: string): StoredCredential[] {
    const rows = this.#db
      .prepare(
        `SELECT provider, secret_hint AS hint, base_url AS baseUrl, updated_at AS updatedAt
         FROM provider_credentials WHERE tenant_id = ? ORDER BY provider`,
      )
      .all(tenantId) as {
      provider: Provider;
      hint: string;
      baseUrl: string | null;
      updatedAt: number;
    }[];

    return rows.map((r) => ({
      provider: r.provider,
      hint: r.hint,
      baseUrl: r.baseUrl ?? undefined,
      updatedAt: r.updatedAt,
    }));
  }

  /**
   * Decrypt a tenant's provider key for an upstream call.
   *
   * The only method that returns plaintext. Callers must pass it straight to
   * the provider and never log, cache in a response, or persist it.
   */
  revealCredential(
    tenantId: string,
    provider: Provider,
  ): { apiKey: string; baseUrl: string | undefined } | undefined {
    const row = this.#db
      .prepare(
        `SELECT encrypted_key AS encryptedKey, base_url AS baseUrl
         FROM provider_credentials WHERE tenant_id = ? AND provider = ?`,
      )
      .get(tenantId, provider) as { encryptedKey: string; baseUrl: string | null } | undefined;

    if (!row) return undefined;
    return {
      apiKey: decryptSecret(row.encryptedKey, this.#masterKey),
      baseUrl: row.baseUrl ?? undefined,
    };
  }

  deleteCredential(tenantId: string, provider: Provider): void {
    this.#db
      .prepare("DELETE FROM provider_credentials WHERE tenant_id = ? AND provider = ?")
      .run(tenantId, provider);
  }

  // ---------------------------------------------------------- subscriptions

  planOf(tenantId: string): PlanId {
    const row = this.#db
      .prepare("SELECT plan FROM subscriptions WHERE tenant_id = ?")
      .get(tenantId) as { plan: string } | undefined;

    // A tenant created before subscriptions existed, or by the CLI, has no
    // row. Free is the safe default: it limits rather than grants.
    if (!row || !isPlanId(row.plan)) return "free";
    return row.plan;
  }

  setPlan(tenantId: string, plan: PlanId): void {
    const now = Date.now();
    this.#db
      .prepare(
        `INSERT INTO subscriptions (tenant_id, plan, started_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at`,
      )
      .run(tenantId, plan, now, now);
  }
}

/**
 * A real scrypt hash of a random value, used to equalise the cost of a login
 * attempt against an address that does not exist.
 */
const DUMMY_PASSWORD_HASH = hashPassword("costgrid-timing-equaliser-not-a-real-password");
