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

   Load this BEFORE script.js:
       <script src="/backend/web/api.js"></script>
       <script src="/script.js"></script>
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

  function post(action, payload, token) {
    var headers = { "Content-Type": "application/json" };
    if (ANON_KEY) headers.apikey = ANON_KEY;
    if (token) headers.Authorization = "Bearer " + token;

    return fetch(FUNCTIONS_URL + "/api", {
      method: "POST",
      headers: headers,
      body: JSON.stringify(Object.assign({ action: action }, payload || {}))
    }).then(function (res) {
      return res.json()
        .catch(function () { return { success: false, message: "Server error." }; })
        .then(function (body) { return { status: res.status, body: body }; });
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

    // Public actions need no token.
    if (action === "registerUser") return post(action, payload).then(unwrap);

    if (action === "loginUser") {
      return post(action, payload).then(function (res) {
        if (res.body && res.body.success && res.body.session) {
          session = {
            access_token: res.body.session.access_token,
            refresh_token: res.body.session.refresh_token,
            expires_at: res.body.session.expires_at,
            user: res.body.user
          };
          saveSession(session);
        }
        return unwrap(res);
      });
    }

    var ready = isExpired(session) ? refreshSession() : Promise.resolve(session);

    return ready.then(function (s) {
      if (!s || !s.access_token) {
        return { success: false, message: "Your session expired. Please log in again." };
      }

      return post(action, payload, s.access_token).then(function (res) {
        // One transparent retry if the token was rejected.
        if (res.status === 401) {
          return refreshSession().then(function (refreshed) {
            if (!refreshed) {
              return { success: false, message: "Your session expired. Please log in again." };
            }
            return post(action, payload, refreshed.access_token).then(unwrap);
          });
        }
        return unwrap(res);
      });
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

  global.DomainVaultAPI = {
    call: call,
    revealPassword: revealPassword,
    restore: restore,
    signOut: signOut,
    get session() { return session; }
  };
})(window);
