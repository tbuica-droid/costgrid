import { createCheckout, createPortal } from "./checkout.mjs";
import { json } from "./http.mjs";

async function readPlan(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return { error: json(400, { error: "Expected a JSON body." }) };
  }
  const plan = body && body.plan;
  if (plan !== "pro" && plan !== "team") return { error: json(400, { error: "Choose Pro or Team." }) };
  return { plan };
}

function failure(err, fallback) {
  const status = err && err.status ? err.status : 502;
  const message = status === 400 || status === 409 ? err.message : fallback;
  return json(status, { error: message });
}

export async function handleCheckout(request, deps) {
  if (request.method && request.method !== "POST") return json(405, { error: "Method not allowed." });
  const parsed = await readPlan(request);
  if (parsed.error) return parsed.error;
  const user = await deps.getUser(request.headers.get("authorization"));
  if (!user) return json(401, { error: "Sign in required." });
  try {
    const result = await createCheckout({ stripe: deps.stripe, store: deps.store, user, plan: parsed.plan });
    return json(200, result);
  } catch (err) {
    return failure(err, "Could not start checkout.");
  }
}

export async function handlePortal(request, deps) {
  if (request.method && request.method !== "POST") return json(405, { error: "Method not allowed." });
  const user = await deps.getUser(request.headers.get("authorization"));
  if (!user) return json(401, { error: "Sign in required." });
  try {
    const result = await createPortal({ stripe: deps.stripe, store: deps.store, user });
    return json(200, result);
  } catch (err) {
    return failure(err, "Could not open billing.");
  }
}
