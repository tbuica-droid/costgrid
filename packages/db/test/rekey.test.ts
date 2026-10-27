import { decryptSecret, deriveMasterKey } from "@costgrid/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountsRepository } from "../src/accounts.js";
import { AlertsRepository } from "../src/alerts.js";
import { openDatabase } from "../src/database.js";
import { rekeySecrets } from "../src/rekey.js";
import { CostGridRepository } from "../src/repositories.js";

const OLD = deriveMasterKey("old-master-key-that-is-long-enough-0123456789");
const NEW = deriveMasterKey("new-master-key-that-is-long-enough-9876543210");

describe("changing the master key", () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase({ path: ":memory:" });
    new CostGridRepository(db).createTenant("Acme", "t1");
    new AccountsRepository(db, OLD).putCredential("t1", "anthropic", "sk-ant-real-key-123");
    new AlertsRepository(db, OLD).configure("t1", { webhookUrl: "https://hooks.example.com/T/SECRET" });
  });
  afterEach(() => db.close());

  it("re-encrypts every secret so only the new key opens it", () => {
    const counts = rekeySecrets(db, OLD, NEW);
    expect(counts).toEqual({ provider_credentials: 1, sso_connections: 0, alert_settings: 1 });

    expect(new AccountsRepository(db, NEW).revealCredential("t1", "anthropic")?.apiKey).toBe("sk-ant-real-key-123");
    expect(new AlertsRepository(db, NEW).webhookUrl("t1")).toBe("https://hooks.example.com/T/SECRET");
    const stored = db.prepare("SELECT encrypted_key AS e FROM provider_credentials").get() as { e: string };
    expect(() => decryptSecret(stored.e, OLD)).toThrow();
  });

  it("changes nothing when the old key is wrong", () => {
    const before = db.prepare("SELECT encrypted_key AS e FROM provider_credentials").get();
    expect(() => rekeySecrets(db, NEW, OLD)).toThrow(/could not decrypt/);
    expect(db.prepare("SELECT encrypted_key AS e FROM provider_credentials").get()).toEqual(before);
    expect(new AccountsRepository(db, OLD).revealCredential("t1", "anthropic")?.apiKey).toBe("sk-ant-real-key-123");
  });

  it("refuses to re-encrypt under the same key", () => {
    expect(() => rekeySecrets(db, OLD, OLD)).toThrow(/same as the old one/);
  });
});
