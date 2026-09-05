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

  if (!readonly) migrate(db);
  return db;
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
