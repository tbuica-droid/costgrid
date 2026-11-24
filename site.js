/*
 * Home page: the optional email sign-in and the "About your setup" questions.
 * Accounts live in Supabase (see auth.js). The page is static, so this runs in
 * the browser: it asks for a sign-in link, notices when the link brings the
 * person back, and shows or hides the [data-auth] parts to match.
 * Kept in its own file so the site's Content-Security-Policy can forbid
 * inline scripts. The Supabase bundle is injected from here the first time
 * someone reaches or uses the sign-in form, or comes back from a magic link.
 */
(function () {
  function boot() {
  if (boot.done || !window.CG_AUTH) return;
  boot.done = true;

  var currentUser = null;
  var checkoutContinued = false;

  function byId(id) { return document.getElementById(id); }

  // Checkout returns here. The plan itself is written by the webhook, so this
  // only says the payment was received. The query is removed so a refresh does
  // not show it again.
  var checkoutParams = new URLSearchParams(location.search);
  if (checkoutParams.get("checkout") === "success") {
    var notice = byId("checkoutNotice");
    if (notice) {
      notice.textContent = "Payment received. Your plan updates once Stripe confirms it, usually within a minute.";
      notice.hidden = false;
    }
    checkoutParams.delete("checkout");
    var cleaned = location.pathname + (checkoutParams.toString() ? "?" + checkoutParams.toString() : "") + location.hash;
    history.replaceState(null, "", cleaned);
  }
  function fieldValue(id) { return byId(id).value.trim(); }
  function show(el, on) { el.hidden = !on; }
  function markInvalid(id, valid) {
    var field = byId(id);
    field.classList.toggle("invalid", !valid);
    var control = field.querySelector("input, select, textarea");
    if (control) control.setAttribute("aria-invalid", valid ? "false" : "true");
    return valid;
  }

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
    showPaying(false);
    if (user) {
      loadProfile(user);
      loadBilling(user);
      maybeContinueCheckout();
    }
  }

  function showPaying(on) {
    document.querySelectorAll("[data-billing='paying']").forEach(function (el) { el.hidden = !on; });
  }

  function isPaying(row) {
    return !!row && (row.plan === "pro" || row.plan === "team") &&
      (row.plan_status === "active" || row.plan_status === "trialing" || row.plan_status === "past_due");
  }

  function loadBilling(user) {
    CG_AUTH.getBilling(user.id).then(function (row) { showPaying(isPaying(row)); }, function () { showPaying(false); });
  }

  var PENDING_PLAN = "cg-checkout-plan";

  function readPending() {
    try { return localStorage.getItem(PENDING_PLAN); } catch (err) { return null; }
  }

  function pendingPlan(value) {
    try {
      if (value) localStorage.setItem(PENDING_PLAN, value);
      else localStorage.removeItem(PENDING_PLAN);
    } catch (err) {}
    var note = byId("checkoutPending");
    if (note) note.hidden = !value;
  }

  function postBilling(path, body) {
    return CG_AUTH.session().then(function (s) {
      if (!s) throw new Error("Sign in required.");
      return fetch(path, {
        method: "POST",
        headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" },
        body: JSON.stringify(body || {})
      });
    }).then(function (res) {
      return res.json().then(function (payload) {
        if (!res.ok || !payload.url) throw new Error(payload && payload.error ? payload.error : "Something went wrong.");
        location.assign(payload.url);
      });
    });
  }

  function startCheckout(plan) {
    var err = byId("checkoutErr");
    if (err) err.hidden = true;
    var buttons = document.querySelectorAll("[data-checkout]");
    buttons.forEach(function (btn) { btn.disabled = true; });
    postBilling("/api/stripe/checkout", { plan: plan }).catch(function (error) {
      if (err) {
        err.textContent = error && error.message ? error.message : "Could not start checkout.";
        err.hidden = false;
      }
      buttons.forEach(function (btn) { btn.disabled = false; });
    });
  }

  function maybeContinueCheckout() {
    if (checkoutContinued) return;
    var plan = readPending();
    if (plan !== "pro" && plan !== "team") return;
    checkoutContinued = true;
    pendingPlan(null);
    startCheckout(plan);
  }

  if (readPending()) pendingPlan(readPending());

  document.querySelectorAll("[data-checkout]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var plan = btn.getAttribute("data-checkout");
      if (plan !== "pro" && plan !== "team") return;
      var known = currentUser ? Promise.resolve(currentUser) : CG_AUTH.session().then(function (s) { return s && s.user; });
      known.then(function (user) {
        if (!user) {
          pendingPlan(plan);
          var setup = byId("setup");
          if (setup) setup.scrollIntoView({ behavior: "smooth" });
          var email = byId("signinEmail");
          if (email) email.focus();
          return;
        }
        currentUser = user;
        pendingPlan(null);
        startCheckout(plan);
      });
    });
  });

  document.querySelectorAll("[data-portal]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var err = byId("checkoutErr");
      btn.disabled = true;
      postBilling("/api/stripe/portal", {}).catch(function (error) {
        if (err) {
          err.textContent = error && error.message ? error.message : "Could not open billing.";
          err.hidden = false;
        }
        btn.disabled = false;
      });
    });
  });

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
      function () {
        showProfile(fields);
        // The answers are saved either way; the email is how a person sees
        // them, so a failure here is not shown to the visitor.
        CG_AUTH.notifyInquiry().catch(function () {});
      },
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
  }

  var SUPABASE_SRC = "vendor/supabase-js-2.117.1.js";
  var AUTH_SRC = "auth.js";
  var pending = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement("script");
      el.src = src;
      el.async = false;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error(src)); };
      document.head.appendChild(el);
    });
  }

  function ensureAuth() {
    if (window.CG_AUTH) {
      boot();
      return Promise.resolve();
    }
    if (!pending) {
      pending = loadScript(SUPABASE_SRC).then(function () {
        return loadScript(AUTH_SRC);
      }).then(function () {
        if (!window.supabase || !window.CG_AUTH) throw new Error("sign-in failed to start");
        boot();
      }).catch(function (err) {
        pending = null;
        throw err;
      });
    }
    return pending;
  }

  // A magic-link return, or a link that lands on the form, has to start the
  // client immediately: the session is read from the URL as the client loads.
  function cameBackSignedIn() {
    var hash = location.hash || "";
    var search = location.search || "";
    if (hash === "#start" || hash === "#setup") return true;
    if (/access_token=|refresh_token=|error_description=|token_hash=|type=(magiclink|signup|recovery|invite|email_change)/.test(hash)) return true;
    if (/[?&](code|error|error_description|token_hash)=/.test(search)) return true;
    return false;
  }

  function holdSubmit(form) {
    if (!form) return;
    form.addEventListener("submit", function (event) {
      if (boot.done) return;
      event.preventDefault();
      event.stopPropagation();
      var submitter = event.submitter;
      ensureAuth().then(function () {
        if (typeof form.requestSubmit === "function") {
          if (submitter) form.requestSubmit(submitter);
          else form.requestSubmit();
        } else {
          form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        }
      }).catch(function () {
        var err = form.querySelector(".err");
        if (err) err.textContent = "Couldn't load sign-in. Check your connection and try again.";
        var field = form.querySelector(".field");
        if (field) field.classList.add("invalid");
      });
    }, true);
  }

  function poke() { ensureAuth().catch(function () {}); }

  var zone = document.getElementById("setup");
  var start = document.getElementById("start");
  holdSubmit(document.getElementById("signinForm"));
  holdSubmit(document.getElementById("profileForm"));

  if (cameBackSignedIn()) poke();

  if (zone && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (entry) { return entry.isIntersecting; })) {
        io.disconnect();
        poke();
      }
    }, { rootMargin: "480px 0px" });
    io.observe(zone);
    if (start) io.observe(start);
  } else if (zone) {
    poke();
  }

  function insideForm(node) {
    return !!(zone && node && zone.contains(node));
  }

  document.addEventListener("focusin", function (event) {
    if (insideForm(event.target)) poke();
  });
  document.addEventListener("pointerdown", function (event) {
    var target = event.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    if (insideForm(target)) poke();
    var link = target && target.closest ? target.closest("a[href]") : null;
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (href === "#start" || href === "#setup" || href.slice(-6) === "#start" || href.slice(-6) === "#setup") poke();
  }, true);
})();

/*
 * After a download starts, show how to open the app the first time: macOS
 * stops apps it can't check, and that one step is where installs are lost.
 */
(function () {
  document.querySelectorAll("[data-download]").forEach(function (link) {
    link.addEventListener("click", function () {
      setTimeout(function () {
        var help = document.getElementById("first-open");
        if (help) help.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 400);
    });
  });
})();
