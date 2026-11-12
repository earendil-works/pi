// A page's link the server refuses because the page runs an older web bundle than the server's (src/hosts/server.ts):
// the WebSocket close the page reloads on (src/hosts/web/main.tsx).

/** The close code of a refused stale page (an application code: 4000 to 4999). */
export const STALE_PAGE_CODE = 4001;

/** The close reason of a refused stale page. */
export const STALE_PAGE_REASON = "p2: stale page, reload";
