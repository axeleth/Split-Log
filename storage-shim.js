/* ==========================================================================
   Split Log — window.storage shim for self-hosting

   app.js persists through `window.storage`, a key-value async API injected by
   the Claude.ai artifact host. That object does not exist on an ordinary web
   server, so without this file loadAll() finds nothing and the page renders
   empty, saving nothing between reloads.

   This provides the same API backed by localStorage. It must load BEFORE
   app.js, and it is deliberately a separate file so app.js stays byte-identical
   to the version that runs on the artifact host.

   The contract is taken from the mock in test/smoke.js, which mirrors the real
   host:

     get(key)         -> { value: <string> }   when the key exists
                      -> null                  when it does not
     set(key, value)  -> truthy on success

   Both are async there, so both are async here. The two shapes that matter:
   loadAll() reads `p.value` off the result, and the hardened save handlers do
   `if(!ok) throw`, so set() must resolve to something truthy rather than
   undefined.

   If window.storage already exists (i.e. this file is served from the artifact
   host, or a real backend has been wired up), this leaves it completely alone.
   ========================================================================== */
(function () {
  'use strict';

  if (window.storage) return;   // a real host wins; never shadow it

  var PREFIX = 'splitlog:';     // namespaced so it cannot collide with anything
                                // else served from the same origin

  // localStorage throws rather than returning null in Safari private browsing
  // and when a site is loaded from file://. Probe once with a real write: mere
  // presence of the object is not proof it works.
  var backing = null;
  try {
    var probe = PREFIX + '__probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    backing = window.localStorage;
  } catch (e) {
    backing = null;
  }

  // Fall back to an in-memory map so the app still runs when localStorage is
  // unavailable. Data is lost on reload, which is worse than persisting but far
  // better than a page that throws on load and renders nothing.
  var memory = Object.create(null);
  var usingMemory = !backing;

  if (usingMemory) {
    console.warn(
      '[Split Log] localStorage is unavailable (private browsing, or the page ' +
      'was opened via file://). Falling back to in-memory storage: your data ' +
      'will NOT survive a reload. Serve the site over http(s) to persist.'
    );
  }

  window.storage = {
    async get(key) {
      var raw;
      if (usingMemory) {
        raw = Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
      } else {
        try {
          raw = backing.getItem(PREFIX + key);
        } catch (e) {
          return null;
        }
      }
      // The host returns null for a missing key, and app.js branches on that to
      // decide whether to migrate or seed defaults. Returning {value: null}
      // would read as "present but empty" and skip both paths.
      return raw === null || raw === undefined ? null : { value: raw };
    },

    async set(key, value) {
      var str = typeof value === 'string' ? value : String(value);
      if (usingMemory) {
        memory[key] = str;
        return true;
      }
      try {
        backing.setItem(PREFIX + key, str);
        return true;
      } catch (e) {
        // Most likely QuotaExceededError. Surface it: the save handlers check
        // this return value and show the user a toast, which is the right
        // outcome — silently reporting success would lose the run they logged.
        console.error('[Split Log] Could not save to localStorage:', e);
        return false;
      }
    },
  };
})();
