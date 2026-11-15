/**
 * Emails support@costgrid.org when a signed-in visitor saves the questions on
 * the website (company, spend, and what they want, quotes included). The
 * website calls it right after saving; it does nothing for anyone else.
 *
 * Deploy:  supabase functions deploy notify-inquiry --no-verify-jwt
 *          (the sign-in token is checked below instead, which also works
 *          with Supabase's newer signing keys)
 * Secrets: supabase secrets set SMTP_USER=support@costgrid.org SMTP_PASS=<Google app password>
 * Supabase provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to every
 * function on its own.
 *
 * Mail goes out through Google Workspace's SMTP server on port 465 (Supabase
 * blocks 25 and 587 from functions). Reply-To is the visitor, so answering
 * the email in Gmail answers them.
 */
import { createClient } from "npm:@supabase/supabase-js@2.117.1";
import nodemailer from "npm:nodemailer@6.9.16";
import { buildMessage, INBOX, type Inquiry } from "./message.ts";

const ORIGINS = new Set(["https://costgrid.org", "http://localhost:8000", "http://127.0.0.1:8000"]);

function cors(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin && ORIGINS.has(origin) ? origin : "https://costgrid.org",
    "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin",
  };
}

Deno.serve(async (req) => {
  const headers = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers });

  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, "content-type": "application/json" } });

  // Who is asking comes from their sign-in token, never from the request body
  // or the email column they wrote themselves.
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "sign in first" });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who.user?.email) return reply(401, { error: "sign in first" });

  // Claimed before sending, so parallel calls send one email between them.
  const { data: rows, error } = await admin.rpc("claim_inquiry_notification", { uid: who.user.id });
  if (error) return reply(500, { error: "could not read the answers" });
  const inquiry = (rows as Inquiry[] | null)?.[0];
  if (!inquiry) return reply(200, { sent: false });

  const { subject, text } = buildMessage(inquiry, who.user.email);
  const user = Deno.env.get("SMTP_USER") ?? INBOX;
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass: Deno.env.get("SMTP_PASS") },
  });
  try {
    await transport.sendMail({ from: `CostGrid website <${user}>`, to: INBOX, replyTo: who.user.email, subject, text });
  } catch (_err) {
    // Give the claim back, so the next save tries again.
    await admin.from("profiles").update({ notified_at: inquiry.previous_notified_at }).eq("id", who.user.id);
    return reply(502, { error: "could not send the email" });
  }

  return reply(200, { sent: true });
});
