import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { logSerializers, redactUrl } from "../src/log-safety.js";

/** The request log must not carry an SSO code, or any other credential in a query string. */

describe("redacting request URLs for the log", () => {
  it("replaces credential values and keeps everything else", () => {
    expect(redactUrl("/console/sso/callback?code=abc123&state=xyz&iss=https%3A%2F%2Fidp")).toBe(
      "/console/sso/callback?code=[redacted]&state=[redacted]&iss=https%3A%2F%2Fidp",
    );
    expect(redactUrl("/v1/models?Key=AIzaSECRET")).toBe("/v1/models?Key=[redacted]");
    expect(redactUrl("/console/t/alerts?limit=50")).toBe("/console/t/alerts?limit=50");
    expect(redactUrl("/plain")).toBe("/plain");
  });

  it("is what Fastify writes when the gateway's serializers are used", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: { level: "info", stream, serializers: logSerializers } });
    app.get("/console/sso/callback", async () => "ok");
    await app.inject({ method: "GET", url: "/console/sso/callback?code=ONE-TIME-CODE&state=STATE-VALUE" });
    await app.close();

    const log = lines.join("");
    expect(log).toContain("/console/sso/callback?code=[redacted]&state=[redacted]");
    expect(log).not.toContain("ONE-TIME-CODE");
    expect(log).not.toContain("STATE-VALUE");
  });
});
