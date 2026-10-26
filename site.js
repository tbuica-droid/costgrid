/*
 * Home page: the optional email sign-in and the "About your setup" questions.
 * Accounts live in Supabase (see auth.js). The page is static, so this runs in
 * the browser: it asks for a sign-in link, notices when the link brings the
 * person back, and shows or hides the [data-auth] parts to match.
 * Kept in its own file so the site's Content-Security-Policy can forbid
 * inline scripts.
 */
(function () {
  if (!window.CG_AUTH) return;

  var currentUser = null;

  function byId(id) { return document.getElementById(id); }
  function fieldValue(id) { return byId(id).value.trim(); }
  function show(el, on) { el.hidden = !on; }
  function markInvalid(id, valid) { byId(id).classList.toggle("invalid", !valid); return valid; }

  function renderAuth(user) {
    currentUser = user;
    document.querySelectorAll("[data-auth]").forEach(function (el) {
      show(el, (el.getAttribute("data-auth") === "in") === !!user);
    });
    document.querySelectorAll("[data-user-email]").forEach(function (el) {
      el.textContent = user ? user.email : "";
    });
    show(byId("signinForm"), !user);
    show(byId("signinSent"), false);
    show(byId("signedIn"), !!user);
    if (user) loadProfile(user);
  }

  var signinForm = byId("signinForm");
  var signinBtn = byId("signinBtn");
  var signinErr = byId("signinErr");
  var signinLabel = signinBtn.textContent;

  // Cheap bot friction. The real limits live in Supabase (its per-email rate
  // limit, and CAPTCHA once it is switched on in the dashboard); this only
  // stops casual scripts and repeat clicks from spamming people's inboxes.
  var RESEND_WAIT_MS = 60 * 1000;
  var lastSentAt = 0;
  try { lastSentAt = Number(sessionStorage.getItem("cg-signin-sent")) || 0; } catch (err) {}

  signinForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var email = fieldValue("signinEmail");
    signinErr.textContent = "Enter a valid email address.";
    if (!markInvalid("f-signin", /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return;
    // A filled honeypot means a bot: act as if it worked and send nothing.
    if (fieldValue("signinWebsite")) {
      byId("sentEmail").textContent = email;
      show(signinForm, false);
      show(byId("signinSent"), true);
      return;
    }
    var wait = lastSentAt + RESEND_WAIT_MS - Date.now();
    if (wait > 0) {
      signinErr.textContent = "Please wait " + Math.ceil(wait / 1000) + " seconds before asking for another link.";
      markInvalid("f-signin", false);
      return;
    }
    lastSentAt = Date.now();
    try { sessionStorage.setItem("cg-signin-sent", String(lastSentAt)); } catch (err) {}
    signinBtn.disabled = true;
    signinBtn.textContent = "Sending…";
    CG_AUTH.sendLink(email).then(
      function () {
        byId("sentEmail").textContent = email;
        show(signinForm, false);
        show(byId("signinSent"), true);
      },
      function (err) {
        signinErr.textContent = "Couldn't send the link: " + (err && err.message ? err.message : "please try again.");
        markInvalid("f-signin", false);
      }
    ).then(function () {
      signinBtn.disabled = false;
      signinBtn.textContent = signinLabel;
    });
  });

  byId("signinAgain").addEventListener("click", function () {
    show(byId("signinSent"), false);
    show(signinForm, true);
    byId("signinEmail").focus();
  });

  byId("signOut").addEventListener("click", function () {
    CG_AUTH.signOut().then(function () { renderAuth(null); });
  });

  // profile: three questions, asked once and kept on the account
  var profileForm = byId("profileForm");
  var profileDone = byId("profileDone");
  var profileErr = byId("profileErr");
  var profileBtn = byId("profileBtn");

  function showProfile(p) {
    if (p) {
      byId("company").value = p.company || "";
      byId("spend").value = p.spend || "";
      byId("notes").value = p.notes || "";
      document.querySelector("[data-profile-summary]").textContent =
        (p.company || "") + ", " + (p.spend || "").toLowerCase() + ".";
    }
    show(profileForm, !p);
    show(profileDone, !!p);
  }

  function loadProfile(user) {
    CG_AUTH.getProfile(user.id).then(showProfile, function () { showProfile(null); });
  }

  profileForm.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!currentUser) return;
    var fields = { company: fieldValue("company"), spend: fieldValue("spend"), notes: fieldValue("notes") };
    var ok = markInvalid("f-company", fields.company.length >= 2 && fields.company.length <= 200);
    ok = markInvalid("f-spend", !!fields.spend) && ok;
    if (fields.notes.length > 2000) fields.notes = fields.notes.slice(0, 2000);
    if (!ok) return;
    profileErr.style.display = "none";
    profileBtn.disabled = true;
    profileBtn.textContent = "Saving…";
    CG_AUTH.saveProfile(currentUser, fields).then(
      function () { showProfile(fields); },
      function (err) {
        profileErr.textContent = "Couldn't save: " + (err && err.message ? err.message : "please try again.");
        profileErr.style.display = "block";
      }
    ).then(function () {
      profileBtn.disabled = false;
      profileBtn.textContent = "Save";
    });
  });

  byId("profileEdit").addEventListener("click", function () {
    show(profileDone, false);
    show(profileForm, true);
  });

  // Runs once now (a returning visitor, or a sign-in link that just landed) and
  // again whenever the session changes. A fresh sign-in scrolls to the setup part.
  CG_AUTH.client.auth.onAuthStateChange(function (event, s) {
    var user = s ? s.user : null;
    if (!!user === !!currentUser && event !== "INITIAL_SESSION") return;
    renderAuth(user);
    if (event === "SIGNED_IN" && user) byId("setup").scrollIntoView({ behavior: "smooth" });
  });
})();
