import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../src/import-run.js";
import { adminKeyAccount, MemorySecretStore } from "../src/secret-store.js";

describe("the admin key store", () => {
  it("names an entry by tenant and provider", () => {
    expect(adminKeyAccount("3f2b9c1e-0000-4000-8000-000000000000", "anthropic")).toBe(
      "admin:3f2b9c1e-0000-4000-8000-000000000000:anthropic",
    );
    expect(adminKeyAccount("local", "openai")).toBe("admin:local:openai");
  });

  it("refuses a part that could name some other entry", () => {
    for (const [tenant, provider] of [
      ["", "openai"],
      ["a:b", "openai"],
      ["tenant", "openai:x"],
      ["../tenant", "openai"],
      ["tenant\n", "openai"],
      ["tenant", ""],
      ["tenant", "OpenAI"],
      ["t".repeat(65), "openai"],
    ] as const) {
      expect(() => adminKeyAccount(tenant, provider), `${tenant} ${provider}`).toThrow(RangeError);
    }
  });

  it("keeps, returns and deletes secrets in memory", async () => {
    const store = new MemorySecretStore();
    expect(store.kind).toBe("memory");
    expect(await store.get("a")).toBeUndefined();
    await store.set("a", "secret");
    expect(await store.get("a")).toBe("secret");
    expect(await store.delete("a")).toBe(true);
    expect(await store.delete("a")).toBe(false);
    expect(store.size).toBe(0);
  });
});

describe("a recorded import error", () => {
  it("never contains the key, or anything shaped like one", () => {
    const key = "sk-ant-admin01-abcdefghijklmnop";
    expect(safeErrorMessage(new Error(`provider returned 401: invalid key ${key}`), key)).toBe(
      "provider returned 401: invalid key [key]",
    );
    // Without being told the key, a key-shaped string still goes.
    expect(safeErrorMessage(new Error("bad sk-proj-0123456789abcdef here"))).toBe("bad [key] here");
    // A key that is not key-shaped goes when it is named.
    expect(safeErrorMessage("token abc123xyz789 rejected", "abc123xyz789")).toBe("token [key] rejected");
  });

  it("is short and on one line", () => {
    const message = safeErrorMessage(new Error(`line one\nline two ${"x".repeat(500)}`));
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message).not.toContain("\n");
    expect(safeErrorMessage(new Error(""))).toBe("unknown error");
  });
});
