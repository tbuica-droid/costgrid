import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

/**
 * OpenID Connect, verified here rather than trusted.
 *
 * Single sign-on moves the decision about who someone is from CostGrid to the
 * customer's identity provider. That is the point of it, and it is also the
 * risk: everything below exists so that "the identity provider said so" means
 * the real provider actually said it, to us, just now.
 *
 * Written against the protocol with no library, because the dependency would
 * be larger than the code and this is a path where reading every line matters
 * more than saving thirty of them.
 *
 * ## What is checked, and what each check stops
 *
 * - **Signature**, against a key fetched from the provider's own JWKS. Stops a
 *   forged token.
 * - **Algorithm allowlist**. Stops `alg: none`, and stops the symmetric-key
 *   confusion where a token signed with the public key as an HMAC secret
 *   verifies against that same public key.
 * - **`iss` exactly equal to the configured issuer**. Stops a token from a
 *   different tenant of the same provider, which is otherwise a genuine,
 *   valid, correctly signed token.
 * - **`aud` containing our client id**. Stops a token issued for a different
 *   application being replayed at ours.
 * - **`exp`, and `nbf` where present**. Stops an old token.
 * - **`nonce` equal to the one we generated**. Ties the token to the sign-in
 *   this browser started, so a token captured elsewhere cannot be pasted in.
 * - **Email domain**, checked by the caller against the connection. Stops a
 *   genuine user of the provider entering an organisation they are not in.
 *
 * A failure anywhere is a failure to sign in. None of these degrade to a
 * warning.
 */

/** Signature algorithms accepted. Asymmetric only, by design. */
const ALLOWED_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "PS256", "ES256", "ES384"]);

/** Tolerance for clock difference between us and the identity provider. */
const CLOCK_SKEW_MS = 2 * 60 * 1000;

export interface OidcEndpoints {
  readonly issuer: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
}

export interface OidcIdentity {
  readonly subject: string;
  readonly email: string;
  readonly name: string;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSegment(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** A random, URL-safe, 256-bit value. Used for state, nonce and the verifier. */
export function randomToken(): string {
  return base64url(randomBytes(32));
}

/**
 * Proof Key for Code Exchange.
 *
 * The authorization code travels through the browser, so anything that can
 * read the redirect can read the code. The verifier never leaves this server:
 * only its hash goes out, and the provider will not exchange the code without
 * the original. A stolen code is therefore useless on its own.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomToken();
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** Constant-time string comparison, for values an attacker can guess at. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Read a provider's endpoints from its discovery document.
 *
 * Run once when a connection is configured, not on every sign-in. Resolving
 * endpoints at sign-in time would make every login depend on a second network
 * hop, and would let a compromised discovery document silently move the token
 * endpoint somewhere else.
 */
export async function discover(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcEndpoints> {
  const base = issuer.replace(/\/$/, "");
  const url = `${base}/.well-known/openid-configuration`;

  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`could not read ${url}: the provider returned ${response.status}`);
  }

  const document = (await response.json()) as Record<string, unknown>;
  const read = (field: string): string => {
    const value = document[field];
    if (typeof value !== "string" || value === "") {
      throw new Error(`the provider's discovery document has no ${field}`);
    }
    return value;
  };

  const discovered = read("issuer");
  // The document states its own issuer. If that disagrees with the address it
  // was fetched from, one of the two is lying and neither can be trusted.
  if (discovered.replace(/\/$/, "") !== base) {
    throw new Error(
      `the discovery document claims issuer ${discovered}, which is not ${issuer}`,
    );
  }

  return {
    issuer: discovered,
    authorizeUrl: read("authorization_endpoint"),
    tokenUrl: read("token_endpoint"),
    jwksUrl: read("jwks_uri"),
  };
}

export function buildAuthorizeUrl(
  connection: { authorizeUrl: string; clientId: string },
  params: { redirectUri: string; state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(connection.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", connection.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Redeem the authorization code for an id token. */
export async function exchangeCode(
  connection: { tokenUrl: string; clientId: string },
  params: { code: string; redirectUri: string; codeVerifier: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: connection.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const response = await fetchImpl(connection.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    // The provider's own error, which is usually the useful one. It cannot
    // contain our secret: that went up, not back.
    const detail = typeof payload["error"] === "string" ? payload["error"] : response.status;
    throw new Error(`the identity provider refused the sign-in: ${detail}`);
  }

  const idToken = payload["id_token"];
  if (typeof idToken !== "string" || idToken === "") {
    throw new Error("the identity provider returned no id token");
  }
  return idToken;
}

interface Jwk extends Record<string, unknown> {
  readonly kid?: string;
  readonly alg?: string;
  readonly kty?: string;
  readonly use?: string;
}

async function fetchKeys(jwksUrl: string, fetchImpl: typeof fetch): Promise<Jwk[]> {
  const response = await fetchImpl(jwksUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`could not read the provider's signing keys: ${response.status}`);
  }
  const document = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(document.keys)) {
    throw new Error("the provider's signing key document has no keys");
  }
  return document.keys as Jwk[];
}

function nodeAlgorithm(alg: string): { name: string; options: Record<string, unknown> } {
  if (alg.startsWith("PS")) {
    // saltLength 32/48/64 for PS256/384/512, matching the digest size.
    const bits = Number(alg.slice(2));
    return {
      name: `sha${bits}`,
      options: { padding: 1 << 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: bits / 8 },
    };
  }
  if (alg.startsWith("ES")) {
    return { name: `sha${alg.slice(2)}`, options: { dsaEncoding: "ieee-p1363" } };
  }
  return { name: `sha${alg.slice(2)}`, options: {} };
}

/**
 * Verify an id token and return the identity inside it.
 *
 * Every check is a rejection, never a downgrade. `email_verified` is the one
 * nuance: providers that send it and say false are rejected, providers that
 * omit it are accepted, because several major ones do not send it for
 * directory accounts where the address is authoritative by definition.
 */
export async function verifyIdToken(
  idToken: string,
  expect: { issuer: string; clientId: string; nonce: string; jwksUrl: string },
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<OidcIdentity> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("the id token is not a JWT");
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  const header = JSON.parse(decodeSegment(headerSegment).toString("utf8")) as {
    alg?: string;
    kid?: string;
  };
  const alg = header.alg ?? "";
  if (!ALLOWED_ALGORITHMS.has(alg)) {
    throw new Error(`the id token is signed with ${alg || "no algorithm"}, which is not accepted`);
  }

  const keys = await fetchKeys(expect.jwksUrl, fetchImpl);
  // With a kid, only that key is tried; a token naming a key the provider does
  // not publish is a forgery, not something to fall back from.
  const candidates = header.kid !== undefined ? keys.filter((k) => k.kid === header.kid) : keys;
  if (candidates.length === 0) {
    throw new Error("the provider does not publish the key this token names");
  }

  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, "utf8");
  const signature = decodeSegment(signatureSegment);
  const { name, options: verifyOptions } = nodeAlgorithm(alg);

  const verified = candidates.some((jwk) => {
    if (jwk.use !== undefined && jwk.use !== "sig") return false;
    if (jwk.alg !== undefined && jwk.alg !== alg) return false;
    try {
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      return verify(name, signed, { key, ...verifyOptions }, signature);
    } catch {
      // A key we cannot parse is not a key we accept. Trying the next one is
      // correct; treating the failure as a pass would not be.
      return false;
    }
  });
  if (!verified) throw new Error("the id token signature is not valid");

  const claims = JSON.parse(decodeSegment(payloadSegment).toString("utf8")) as Record<
    string,
    unknown
  >;

  const issuer = typeof claims["iss"] === "string" ? claims["iss"] : "";
  if (issuer.replace(/\/$/, "") !== expect.issuer.replace(/\/$/, "")) {
    throw new Error(`the id token was issued by ${issuer || "nobody"}, not by ${expect.issuer}`);
  }

  const audience = claims["aud"];
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(expect.clientId)) {
    throw new Error("the id token was issued for a different application");
  }

  const exp = typeof claims["exp"] === "number" ? claims["exp"] * 1000 : 0;
  if (exp === 0 || exp + CLOCK_SKEW_MS < now) throw new Error("the id token has expired");
  const nbf = typeof claims["nbf"] === "number" ? claims["nbf"] * 1000 : undefined;
  if (nbf !== undefined && nbf - CLOCK_SKEW_MS > now) {
    throw new Error("the id token is not valid yet");
  }

  const nonce = typeof claims["nonce"] === "string" ? claims["nonce"] : "";
  if (!secretEquals(nonce, expect.nonce)) {
    throw new Error("the id token does not answer this sign-in");
  }

  const email = typeof claims["email"] === "string" ? claims["email"].trim().toLowerCase() : "";
  if (email === "") throw new Error("the id token carries no email address");
  if (claims["email_verified"] === false) {
    throw new Error("the identity provider has not verified that email address");
  }

  const subject = typeof claims["sub"] === "string" ? claims["sub"] : "";
  if (subject === "") throw new Error("the id token carries no subject");

  const name_ = typeof claims["name"] === "string" ? claims["name"] : "";
  return { subject, email, name: name_ };
}
