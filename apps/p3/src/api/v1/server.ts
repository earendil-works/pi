// p3's API v1 for server facets (`@earendil-works/p3/v1/server`): what only server facets import. The kit's start
// data on the server (`AppInfo`), the registry of HTTP routes (`Http`), and the contracts base code reads and a plugin
// serves (`SessionRoute`).

import { bool, local, str } from "@earendil-works/chord";

export { Http } from "@earendil-works/chord/http";
export { AppInfo } from "../../kit/info.ts";

/**
 * What the route to a session's worker asks before it starts or reaches one: whether the session exists. The API owns
 * the contract because the route is base code, which never reloads and keeps the contract it was built with; the
 * sessions plugin serves it.
 */
export const SessionRoute = local("p3.session-route", {
	version: 1,
	params: { session: str() },
	members: { exists: bool() },
});
