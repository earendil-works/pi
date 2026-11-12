// What a `/chord` link names, and the refusal of a page's link from older code (src/hosts/server.ts): the WebSocket
// close the page reloads on (src/hosts/web/main.tsx). A page served here names its base bundle (`?web=<base>`); every
// other client names itself (`?client=`): the TUI, a Cloud Brain page (built elsewhere: scripts/cloud-bundle.ts), a
// script or test holding contracts directly. A link naming neither is a page from before pages named their base: it
// would re-hold types removed since (each waiting on the session worker), so it is refused like a stale page.

/** The close code of a refused stale page (an application code: 4000 to 4999). */
export const STALE_PAGE_CODE = 4001;

/** The close reason of a refused stale page. */
export const STALE_PAGE_REASON = "p2: stale page, reload";

/** The clients a link may name instead of a base bundle (`/chord?client=<client>`). */
export const LINK_CLIENTS = ["tui", "cloud", "script"] as const;

/** A client a link names instead of a base bundle. */
export type LinkClient = (typeof LINK_CLIENTS)[number];

/** The `/chord` link path (with its query) of `client`. */
export function clientLinkPath(client: LinkClient): string {
	return `/chord?client=${client}`;
}

/** Whether `name` (a link's `client` query) is a client that names no base bundle. */
export function isLinkClient(name: string | null): boolean {
	return LINK_CLIENTS.some((client) => client === name);
}
