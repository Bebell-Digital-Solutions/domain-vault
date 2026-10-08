/* ==========================================================================
   Domain Vault — frontend API client
   ==========================================================================
   Drop-in replacement for the Google Apps Script transport in script.js.

   The action names and response shapes are unchanged, so rendering code does
   not move. What changes:

     * Requests carry a signed JWT instead of an email address in the body.
       The server derives identity from the token, so the client can no longer
       ask for someone else's data.
     * The session survives a page reload, which the old build did not.
     * Expired access tokens are refreshed transparently, once, on 401.

   Load order (see index.html / admin.html):
       <script src="config.js"></script>
       <script src="api.js"></script>
       <script src="script.js"></script>
   ========================================================================== */

(function (global) {
  "use strict";

  var CONFIG = global.DOMAIN_VAULT_CONFIG || {};
  var FUNCTIONS_URL = CONFIG.functionsUrl || "";   // https://<ref>.supabase.co/functions/v1
  var SUPABASE_URL  = CONFIG.supabaseUrl  || "";   // https://<ref>.supabase.co
  var ANON_KEY      = CONFIG.anonKey      || "";   // publishable anon key

  var STORAGE_KEY = "dv.session";

  /* ---------------------------------------------------------------- session */

  function loadSession() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null; // private mode, or storage disabled
    }
  }

  function saveSession(session) {
    try {
      if (session) global.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      else global.localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      /* non-fatal: the session just will not survive a reload */
    }
  }

  var session = loadSession();

  /** Make a session the API handed back the current one, keeping the user. */
  function adoptSession(fresh, user) {
    session = {
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires_at: fresh.expires_at,
      user: user || (session ? session.user : null)
    };
    saveSession(session);
  }

  function isExpired(s) {
    if (!s || !s.expires_at) return true;
    // Refresh a minute early so a request cannot expire mid-flight.
    return (s.expires_at * 1000) - Date.now() < 60000;
  }

  /** Exchange the refresh token for a new access token. */
  function refreshSession() {
    if (!session || !session.refresh_token) return Promise.resolve(null);

    return fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !data.access_token) {
          session = null;
          saveSession(null);
          return null;
        }
        session = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: data.expires_at ||
            Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
          user: session ? session.user : null
        };
        saveSession(session);
        return session;
      })
      .catch(function () { return null; });
  }

  /* ---------------------------------------------------------------- transport */

  /** POST a JSON body to one edge function; resolves with { status, body }. */
  function postTo(fn, body, token) {
    var headers = { "Content-Type": "application/json" };
    if (ANON_KEY) headers.apikey = ANON_KEY;
    if (token) headers.Authorization = "Bearer " + token;

    return fetch(FUNCTIONS_URL + "/" + fn, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json()
        .catch(function () { return { success: false, message: "Server error." }; })
        .then(function (body) { return { status: res.status, body: body }; });
    });
  }

  function post(action, payload, token) {
    return postTo("api", Object.assign({ action: action }, payload || {}), token);
  }

  var EXPIRED = { success: false, expired: true, message: "Your session expired. Please log in again." };

  /**
   * Send a request as the signed-in user: refresh the token first if it is
   * about to expire, and retry once with a fresh one if it is rejected.
   * `send(token)` performs the request and resolves with { status, body }.
   */
  function authed(send) {
    var ready = isExpired(session) ? refreshSession() : Promise.resolve(session);

    return ready.then(function (s) {
      if (!s || !s.access_token) return EXPIRED;

      return send(s.access_token).then(function (res) {
        if (res.status === 401) {
          return refreshSession().then(function (refreshed) {
            if (!refreshed) return EXPIRED;
            return send(refreshed.access_token).then(unwrap);
          });
        }
        return unwrap(res);
      });
    });
  }

  /**
   * Same signature as the old apiCall(action, payload).
   * Resolves with the response body; rejects on transport failure.
   */
  function call(action, payload) {
    if (!FUNCTIONS_URL) {
      return Promise.reject(new Error("DOMAIN_VAULT_CONFIG.functionsUrl is not set"));
    }

    // Public actions need no token. Keep in sync with PUBLIC_ACTIONS in the
    // api function.
    if (action === "registerUser" || action === "getPrices" || action === "getCatalog" ||
        action === "requestPasswordReset") {
      return post(action, payload).then(unwrap);
    }

    if (action === "loginUser") {
      return post(action, payload).then(function (res) {
        if (res.body && res.body.success && res.body.session) {
          adoptSession(res.body.session, res.body.user);
        }
        return unwrap(res);
      });
    }

    return authed(function (token) { return post(action, payload, token); }).then(function (body) {
      // A password change ends every other session, this tab's included, and
      // hands back the one that made the change.
      if (body && body.success && body.session && body.session.access_token) {
        adoptSession(body.session);
        delete body.session;
      }
      return body;
    });
  }

  function unwrap(res) {
    return res.body;
  }

  /* ---------------------------------------------------------------- extras */

  /** Reveal one stored registrar password. Rate limited and audited server-side. */
  function revealPassword(providerId) {
    return call("revealCredential", { providerId: providerId });
  }

  /**
   * WHOIS or DNS through the lookup function, which validates the name,
   * caches answers and rate limits per user. kind: "whois" | "dns".
   * Resolves with { success, data } or { success: false, error }.
   */
  function lookup(domain, kind, types) {
    if (!FUNCTIONS_URL) return Promise.reject(new Error("DOMAIN_VAULT_CONFIG.functionsUrl is not set"));
    var body = { domain: domain, kind: kind === "dns" ? "dns" : "whois" };
    if (types) body.types = types;
    return authed(function (token) { return postTo("lookup", body, token); });
  }

  /** Private subscription URL for a calendar feed token (see the calendar function). */
  function calendarFeedUrl(token) {
    return FUNCTIONS_URL + "/calendar?token=" + encodeURIComponent(token);
  }

  /* ------------------------------------------------------- password reset */

  /**
   * The reset email links back here with the outcome in the URL fragment:
   * tokens and type=recovery on success, error_description when the link was
   * expired or already used. Returns null when this page load is not one.
   */
  function recoveryFromUrl() {
    var hash = (global.location.hash || "").replace(/^#/, "");
    if (!hash) return null;
    var params = new URLSearchParams(hash);
    if (params.get("type") === "recovery" && params.get("access_token")) {
      return { accessToken: params.get("access_token") };
    }
    if (params.get("error") || params.get("error_description")) {
      return { error: params.get("error_description") || "This reset link is invalid." };
    }
    return null;
  }

  /**
   * Set a new password with the short-lived recovery token, then sign that
   * account out everywhere: whoever had the old password loses their session.
   * The user logs in normally afterwards, which re-checks their account status.
   */
  function setPasswordWithRecovery(accessToken, newPassword) {
    var headers = {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": "Bearer " + accessToken
    };
    return fetch(SUPABASE_URL + "/auth/v1/user", {
      method: "PUT",
      headers: headers,
      body: JSON.stringify({ password: newPassword })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          return {
            success: false,
            message: body.msg || body.message || body.error_description ||
              "Could not set the new password. Request a new reset link."
          };
        }
        return fetch(SUPABASE_URL + "/auth/v1/logout?scope=global", { method: "POST", headers: headers })
          .catch(function () { /* the password is changed either way */ })
          .then(function () { return { success: true }; });
      });
    });
  }

  /** Restore a signed-in user after a page reload; null if not signed in. */
  function restore() {
    if (!session) return Promise.resolve(null);
    return (isExpired(session) ? refreshSession() : Promise.resolve(session))
      .then(function (s) { return s && s.user ? s.user : null; });
  }

  function signOut() {
    session = null;
    saveSession(null);
  }

  /** Merge fresh account fields (plan, isAdmin) into the stored session user. */
  function updateUser(patch) {
    if (!session || !session.user || !patch) return;
    session.user = Object.assign({}, session.user, patch);
    saveSession(session);
  }

  global.DomainVaultAPI = {
    call: call,
    lookup: lookup,
    calendarFeedUrl: calendarFeedUrl,
    recoveryFromUrl: recoveryFromUrl,
    setPasswordWithRecovery: setPasswordWithRecovery,
    revealPassword: revealPassword,
    restore: restore,
    signOut: signOut,
    updateUser: updateUser,
    get session() { return session; }
  };
})(window);
