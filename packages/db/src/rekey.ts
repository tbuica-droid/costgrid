import { decryptSecret, encryptSecret } from "@costgrid/core";
import type { Db } from "./database.js";

/**
 * Re-encrypt every stored secret under a new master key.
 *
 * Three columns hold secrets encrypted under the master key: tenants'
 * provider keys, single sign-on client secrets and alert webhook addresses.
 * All of them are decrypted with the old key and encrypted with the new one
 * in a single transaction, so a wrong old key, or any row that will not
 * decrypt, changes nothing at all: there is never a database with secrets
 * under two different keys.
 *
 * Changing the key is how a suspected leak of the old one is closed. After
 * this, restart the gateway with the new key; the old one opens nothing.
 */

const COLUMNS = [
  { table: "provider_credentials", column: "encrypted_key", key: ["tenant_id", "provider"] },
  { table: "sso_connections", column: "encrypted_secret", key: ["tenant_id"] },
  { table: "alert_settings", column: "encrypted_webhook", key: ["tenant_id"] },
] as const;

export type RekeyResult = Readonly<Record<(typeof COLUMNS)[number]["table"], number>>;

export function rekeySecrets(db: Db, oldKey: Buffer, newKey: Buffer): RekeyResult {
  if (oldKey.equals(newKey)) throw new Error("the new master key is the same as the old one");
  return db.transaction(() => {
    const counts: Record<string, number> = {};
    for (const { table, column, key } of COLUMNS) {
      const rows = db
        .prepare(`SELECT ${key.join(", ")}, ${column} AS secret FROM ${table} WHERE ${column} IS NOT NULL`)
        .all() as Record<string, string>[];
      const update = db.prepare(
        `UPDATE ${table} SET ${column} = ? WHERE ${key.map((k) => `${k} = ?`).join(" AND ")}`,
      );
      for (const row of rows) {
        const plaintext = decryptSecret(row["secret"]!, oldKey);
        update.run(encryptSecret(plaintext, newKey), ...key.map((k) => row[k]));
      }
      counts[table] = rows.length;
    }
    return counts as RekeyResult;
  })();
}
