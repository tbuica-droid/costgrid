import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, for Bedrock.
 *
 * Written rather than taken from the AWS SDK because the gateway has three
 * runtime dependencies and the SDK would be the largest by an order of
 * magnitude, pulled in for one signature. The algorithm is a published
 * specification and is exercised below against Amazon's own test vectors, so
 * this is one of the few parts of a channel integration that can be verified
 * without an account.
 *
 * Deliberately minimal: single-chunk signing of a JSON body, which is all the
 * Bedrock runtime needs. No chunked uploads, no presigned URLs, no S3 quirks.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present when the caller used STS — a role, or SSO. */
  readonly sessionToken?: string | undefined;
}

export interface SignatureInput {
  readonly method: string;
  readonly url: URL;
  readonly region: string;
  readonly service: string;
  readonly body: string;
  readonly credentials: AwsCredentials;
  /** Overridable so a signature can be reproduced exactly in a test. */
  readonly now?: Date;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

/**
 * Percent-encode for a canonical request.
 *
 * AWS's rules are not `encodeURIComponent`'s: the unreserved set is exactly
 * A-Z a-z 0-9 - _ . ~, and a path segment's slashes survive while everything
 * else is encoded. Getting this wrong produces a signature mismatch that reads
 * as an authentication failure, which is a miserable thing to debug.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(pathname: string): string {
  if (pathname === "") return "/";
  return pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of url.searchParams) pairs.push([key, value]);
  // Sorted by key, then by value — both already encoded.
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join("&");
}

function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Sign a request, returning the headers to send.
 *
 * `host` is signed and must therefore be sent; fetch sets it itself, and the
 * value signed here has to match what goes on the wire — including the port
 * when it is non-default, which is how a signature breaks against a local
 * stub but not against AWS.
 */
export function signRequest(input: SignatureInput): Record<string, string> {
  const { method, url, region, service, body, credentials } = input;
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = stamps(now);

  const payloadHash = sha256(body);
  const host = url.host;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Exposed for the test that checks against Amazon's published vectors. */
export const __internal = { canonicalPath, canonicalQuery, sha256 };
