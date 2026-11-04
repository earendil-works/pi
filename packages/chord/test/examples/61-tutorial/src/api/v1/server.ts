// The todo app's API v1 for server facets (`@todo/app/v1/server`): the HTTP registry plugins add routes to, the kit's
// pick-a-name login as a facet a one-line plugin exports, and the app's telemetry store (where it is, how a server
// facet opens it to read) with the kit's `AppInfo`, which names the data directory.

import { ephemeralLoginFacet } from "../../../../../../src/node/app/index.ts";
import type { TodoPrincipal } from "../../principals.ts";

export type { StoredSpan, StoredTrace } from "@earendil-works/pi-telemetry";
export { AppInfo } from "../../../../../../src/node/app/index.ts";
export { Http } from "../../../../../../src/node/http/index.ts";
export { openTelemetry, type TodoTelemetry, telemetryFile } from "../../telemetry.ts";

/** The kit's ephemeral login: `POST /_chord/login { name }` signs in as `{ kind: "user", id, name }`. */
export const login = ephemeralLoginFacet<TodoPrincipal>();
