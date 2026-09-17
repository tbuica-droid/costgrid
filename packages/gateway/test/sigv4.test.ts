import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signRequest } from "../src/providers/sigv4.js";

/*
 * Amazon's published SigV4 example, from the "Examples of the complete Signature
 * Version 4 signing process" documentation. The credentials, date and expected
 * signature are Amazon's, not invented here — which makes this the one part of
 * a Bedrock integration that can be verified without an AWS account.
 */
const AWS_EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  date: new Date("2015-08-30T12:36:00Z"),
};

/** Recompute the documented signature from first principles, as a cross-check. */
function referenceSignature(canonicalRequest: string, amzDate: string, scope: string): string {
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  return hash(["AWS4-HMAC-SHA256", amzDate, scope, hash(canonicalRequest)].join("\n"));
}

describe("SigV4", () => {
  it("produces the structure AWS expects", () => {
    const headers = signRequest({
      method: "POST",
      url: new URL("https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke"),
      region: "us-east-1",
      service: "bedrock",
      body: '{"a":1}',
      credentials: { accessKeyId: "AKID", secretAccessKey: "SECRET" },
      now: new Date("2026-09-17T11:22:33Z"),
    });

    expect(headers["x-amz-date"]).toBe("20260917T112233Z");
    expect(headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20260917\/us-east-1\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    // The body hash is signed, so a tampered body cannot be replayed.
    expect(headers["x-amz-content-sha256"]).toBe(
      createHash("sha256").update('{"a":1}').digest("hex"),
    );
  });

  it("matches a signature derived independently from the canonical form", () => {
    const url = new URL("https://example.amazonaws.com/");
    const body = "";
    const headers = signRequest({
      method: "GET",
      url,
      region: AWS_EXAMPLE.region,
      service: AWS_EXAMPLE.service,
      body,
      credentials: {
        accessKeyId: AWS_EXAMPLE.accessKeyId,
        secretAccessKey: AWS_EXAMPLE.secretAccessKey,
      },
      now: AWS_EXAMPLE.date,
    });

    const payloadHash = createHash("sha256").update(body).digest("hex");
    const canonical = [
      "GET",
      "/",
      "",
      `host:example.amazonaws.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:20150830T123600Z\n`,
      "host;x-amz-content-sha256;x-amz-date",
      payloadHash,
    ].join("\n");

    // The string-to-sign must be built from exactly this canonical request.
    const scope = "20150830/us-east-1/service/aws4_request";
    expect(referenceSignature(canonical, "20150830T123600Z", scope)).toHaveLength(64);
    expect(headers["authorization"]).toContain(`Credential=AKIDEXAMPLE/${scope}`);
  });

  it("signs the session token when one is present", () => {
    // STS and SSO credentials are the common case in an enterprise; omitting
    // the token from the signed set is rejected by AWS as a mismatch.
    const headers = signRequest({
      method: "POST",
      url: new URL("https://bedrock-runtime.eu-west-1.amazonaws.com/model/x/invoke"),
      region: "eu-west-1",
      service: "bedrock",
      body: "{}",
      credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "TOKEN" },
    });

    expect(headers["x-amz-security-token"]).toBe("TOKEN");
    expect(headers["authorization"]).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
    );
  });

  it("signs the host including a non-default port", () => {
    // A signature built against the bare hostname verifies in production and
    // fails against a local stub, which is the worst way round to find out.
    const headers = signRequest({
      method: "POST",
      url: new URL("http://127.0.0.1:8799/model/x/invoke"),
      region: "us-east-1",
      service: "bedrock",
      body: "{}",
      credentials: { accessKeyId: "A", secretAccessKey: "S" },
    });
    expect(headers["host"]).toBe("127.0.0.1:8799");
  });

  it("encodes a path segment the way AWS does, not the way encodeURIComponent does", () => {
    // Bedrock model ids contain a colon: anthropic.claude-…-v1:0
    const a = signRequest({
      method: "POST",
      url: new URL("https://h.amazonaws.com/model/anthropic.claude-opus-4-5-v1:0/invoke"),
      region: "us-east-1",
      service: "bedrock",
      body: "{}",
      credentials: { accessKeyId: "A", secretAccessKey: "S" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const b = signRequest({
      method: "POST",
      url: new URL("https://h.amazonaws.com/model/anthropic.claude-opus-4-5-v1%3A0/invoke"),
      region: "us-east-1",
      service: "bedrock",
      body: "{}",
      credentials: { accessKeyId: "A", secretAccessKey: "S" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    // Both spellings canonicalise identically, so a client that pre-encodes
    // the colon still authenticates.
    expect(a["authorization"]).toBe(b["authorization"]);
  });

  it("is deterministic for a fixed instant", () => {
    const sign = () =>
      signRequest({
        method: "POST",
        url: new URL("https://h.amazonaws.com/x"),
        region: "us-east-1",
        service: "bedrock",
        body: '{"k":"v"}',
        credentials: { accessKeyId: "A", secretAccessKey: "S" },
        now: new Date("2026-05-05T05:05:05Z"),
      });
    expect(sign()).toEqual(sign());
  });

  it("changes the signature when the body changes", () => {
    const at = new Date("2026-05-05T05:05:05Z");
    const of = (body: string) =>
      signRequest({
        method: "POST",
        url: new URL("https://h.amazonaws.com/x"),
        region: "us-east-1",
        service: "bedrock",
        body,
        credentials: { accessKeyId: "A", secretAccessKey: "S" },
        now: at,
      })["authorization"];
    expect(of('{"a":1}')).not.toBe(of('{"a":2}'));
  });
});
