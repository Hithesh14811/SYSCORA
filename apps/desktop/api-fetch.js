// EVERY /api CALL NEEDS THE TOKEN, AND A SECOND SURFACE FORGOT IT.
//
// The daemon authenticates every mutating route with `x-syscora-token`, and the
// static page is served WITHOUT it on purpose so the token is never in the HTML
// — clients get it out of band (the Electron shell injects it in-process; a
// browser is given the Connect panel). `demo.js` has wrapped `window.fetch` to
// attach it since it was written.
//
// The overlay then reproduced the fetch calls and not the wrapper, so the first
// thing anybody typed into the floating box came back:
//
//     Unauthorized: missing or invalid x-syscora-token header.
//
// A copied behaviour that was never a shared function is a behaviour the next
// surface will also forget, so it is a function now. `demo.js` keeps its own
// inline copy for the moment — it has extra work to do on a 401, and rewriting a
// working auth path was not worth the risk of this change.

/**
 * A `fetch` that carries the API token on requests to this daemon.
 *
 * Which requests: anything on `/api/`, and anything explicitly aimed at the
 * loopback address. Static assets are deliberately NOT authenticated, so a
 * blanket header would be sending the credential where it is not needed.
 *
 * A missing token is not an error here. It means this page has not been given
 * one — a plain browser before the Connect panel — and the request goes out
 * bare so the daemon can answer 401 and the surface can say so.
 */
export function withApiToken(fetchImpl, token) {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    const isApi = url.startsWith("/api/") || url.includes("://127.0.0.1");
    if (!isApi || !token) return fetchImpl(input, init);
    return fetchImpl(input, {
      ...init,
      // The wrapper's token wins over a caller's, which is what `demo.js` has
      // always done. Two surfaces disagreeing about which credential goes out
      // would be far worse than the theoretical case this forecloses, and no
      // caller sets its own.
      headers: { ...(init.headers ?? {}), "x-syscora-token": token }
    });
  };
}
