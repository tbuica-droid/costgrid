/*
 * Website sign-in, shared by the front page and the demo. Accounts live in
 * Supabase; this file only talks to it with the publishable key, which is
 * meant to be public. Nothing here touches the gateway or a customer's API
 * keys: the account is for the website only.
 */
window.CG_AUTH = (function () {
  var SUPABASE_URL = "https://wuxrdpsuykzsfdfpbnmi.supabase.co";
  var SUPABASE_KEY = "sb_publishable_J2KxcwgXWAaz3ptBMwzTgA_UMEzxj1v";
  var client = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  function session() {
    return client.auth.getSession().then(function (r) { return r.data.session; });
  }

  // Emails a one-time sign-in link. The link brings the person back to the
  // front page, where the session is picked up from the URL automatically.
  function sendLink(email) {
    return client.auth
      .signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + "/" } })
      .then(function (r) { if (r.error) throw r.error; });
  }

  function signOut() {
    return client.auth.signOut();
  }

  function getProfile(userId) {
    return client
      .from("profiles")
      .select("company,spend,notes")
      .eq("id", userId)
      .maybeSingle()
      .then(function (r) { if (r.error) throw r.error; return r.data; });
  }

  function saveProfile(user, fields) {
    return client
      .from("profiles")
      .upsert({
        id: user.id,
        email: user.email,
        company: fields.company,
        spend: fields.spend,
        notes: fields.notes || null,
        updated_at: new Date().toISOString()
      })
      .then(function (r) { if (r.error) throw r.error; });
  }

  // For pages that are only for signed-in people. The page stays hidden until
  // the check passes; anyone without a session is sent to the sign-in card.
  function requireSession(signInUrl) {
    document.documentElement.style.visibility = "hidden";
    session().then(
      function (s) {
        if (s) document.documentElement.style.visibility = "";
        else location.replace(signInUrl);
      },
      function () { location.replace(signInUrl); }
    );
  }

  return {
    client: client,
    session: session,
    sendLink: sendLink,
    signOut: signOut,
    getProfile: getProfile,
    saveProfile: saveProfile,
    requireSession: requireSession
  };
})();
