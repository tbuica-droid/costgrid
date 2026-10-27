import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { notReadyReason, openDatabase, pendingMigrations, rotateBackup } from "../src/database.js";
import { MIGRATIONS } from "../src/schema.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "costgrid-backup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backups", () => {
  it("writes a consistent copy that opens and holds the data", () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, "costgrid.db") });
    db.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('kept');");

    const written = rotateBackup(db, join(dir, "backups"), 7, new Date("2026-10-27T10:00:00Z"));
    const copy = new Database(written, { readonly: true });
    expect(copy.prepare("SELECT v FROM marker").get()).toEqual({ v: "kept" });
    copy.close();
    db.close();
  });

  it("keeps one file a day and only the newest few", () => {
    const dir = tempDir();
    const db = openDatabase({ path: join(dir, "costgrid.db") });
    const backups = join(dir, "backups");
    for (let day = 1; day <= 5; day++) rotateBackup(db, backups, 3, new Date(`2026-10-0${day}T09:00:00Z`));
    rotateBackup(db, backups, 3, new Date("2026-10-05T21:00:00Z"));

    expect(readdirSync(backups).sort()).toEqual([
      "costgrid-2026-10-03.db",
      "costgrid-2026-10-04.db",
      "costgrid-2026-10-05.db",
    ]);
    db.close();
  });

  it("copies an existing database before migrating it, and not a new one", () => {
    const dir = tempDir();
    const path = join(dir, "costgrid.db");

    openDatabase({ path }).close();
    expect(readdirSync(dir).some((f) => f.includes("before-migration"))).toBe(false);

    // Pretend the newest migration has not run yet, as after an upgrade.
    const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    const raw = new Database(path);
    raw.prepare("DELETE FROM schema_migrations WHERE version = ?").run(latest);
    raw.close();

    // The migration re-runs against tables that exist; whether it succeeds is
    // the migrations suite's business. The copy must exist either way.
    try {
      openDatabase({ path }).close();
    } catch {
      /* expected for a non-idempotent migration */
    }
    expect(existsSync(`${path}.before-migration-${latest}.bak`)).toBe(true);
  });
});

describe("readiness", () => {
  it("is ready once the schema is current", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(pendingMigrations(db)).toEqual([]);
    expect(notReadyReason(db)).toBeUndefined();
    db.close();
  });

  it("is not ready with migrations outstanding or a closed database", () => {
    const db = new Database(":memory:");
    expect(notReadyReason(db)).toMatch(/migration\(s\) not applied/);
    db.close();
    expect(notReadyReason(db)).toBe("the database is closed");
  });
});
