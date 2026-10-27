import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";

export type Db = Database.Database;

export interface OpenOptions {
  /** Filesystem path, or ":memory:" for an ephemeral database (tests). */
  readonly path: string;
  readonly readonly?: boolean;
}

/**
 * Open the database and bring it up to the current schema version.
 *
 * Migrations run inside a single transaction per version and are recorded in
 * `schema_migrations`, so re-opening an up-to-date database is a no-op.
 */
export function openDatabase({ path, readonly = false }: OpenOptions): Db {
  const db = new Database(path, { readonly });

  // WAL lets the dashboard read while the gateway is writing. Without it a
  // read would block the metering path, which sits in the request critical path.
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  db.pragma("foreign_keys = ON");

  if (!readonly) {
    // Migrations only go forward, so the way back from a bad one is the copy
    // taken just before it. Only an existing database with something to lose
    // gets one; a brand-new or in-memory database does not.
    const pending = pendingMigrations(db);
    if (pending.length > 0 && path !== ":memory:" && appliedMigrations(db).size > 0) {
      const latest = pending[pending.length - 1]!;
      snapshotDatabase(db, `${path}.before-migration-${latest}.bak`);
    }
    migrate(db);
  }
  return db;
}

/**
 * Copy the database to `destination`, safely, while it is in use.
 *
 * Not the same as `cp`. In WAL mode recent commits live in the `-wal` sidecar
 * until a checkpoint, so copying the main file alone silently loses the most
 * recent writes — exactly the calls a customer is most likely to be asking
 * about. SQLite's backup API checkpoints as it goes and produces a single
 * consistent file.
 */
export async function backupDatabase(db: Db, destination: string): Promise<void> {
  await db.backup(destination);
}

/**
 * The same consistent copy, synchronously, for the places that cannot wait:
 * just before a migration, and from a timer that must not overlap itself.
 * Overwrites `destination`.
 */
export function snapshotDatabase(db: Db, destination: string): void {
  rmSync(destination, { force: true });
  db.prepare("VACUUM INTO ?").run(destination);
}

const BACKUP_PREFIX = "costgrid-";
const BACKUP_SUFFIX = ".db";

/**
 * Today's backup into `dir`, keeping the newest `keep` and deleting older
 * ones. One file per UTC day, so running it twice a day replaces rather
 * than piles up. Returns the path written.
 */
export function rotateBackup(db: Db, dir: string, keep: number, at = new Date()): string {
  if (!Number.isInteger(keep) || keep < 1) throw new RangeError(`keep must be at least 1, got ${keep}`);
  mkdirSync(dir, { recursive: true });
  const day = at.toISOString().slice(0, 10);
  const destination = join(dir, `${BACKUP_PREFIX}${day}${BACKUP_SUFFIX}`);
  snapshotDatabase(db, destination);
  const backups = readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) rmSync(join(dir, old), { force: true });
  return destination;
}

function appliedMigrations(db: Db): Set<number> {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (table === undefined) return new Set();
  return new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );
}

/** Migration versions this build knows that the database has not had yet, in order. */
export function pendingMigrations(db: Db): number[] {
  const applied = appliedMigrations(db);
  return MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version);
}

/**
 * Whether this database can take traffic: open for writing, schema current.
 * `undefined` when it can, otherwise the reason in a sentence.
 */
export function notReadyReason(db: Db): string | undefined {
  if (!db.open) return "the database is closed";
  if (db.readonly) return "the database is open read-only";
  try {
    db.prepare("SELECT 1").get();
  } catch {
    return "the database does not answer";
  }
  const pending = pendingMigrations(db);
  if (pending.length > 0) return `${pending.length} database migration(s) not applied`;
  return undefined;
}

export function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    })();
  }
}
