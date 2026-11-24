const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Confirms the bearer token with Supabase Auth. Decoding the JWT locally would
 * trust a signature we do not check and a session that may already be revoked.
 * The service-role client is the apikey; the user token is the argument.
 */
export async function userFromAuthorization(supabase, authorization) {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization || "");
  if (!match) return null;
  const { data, error } = await supabase.auth.getUser(match[1]);
  if (error || !data || !data.user || !UUID.test(data.user.id)) return null;
  return { id: data.user.id, email: data.user.email || null };
}
