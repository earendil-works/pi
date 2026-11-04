// The todo app's API v1 for server facets (`@todo/app/v1/server`): the HTTP registry plugins add routes to, and the
// kit's pick-a-name login as a facet a one-line plugin exports.

import { ephemeralLoginFacet } from "../../../../../../src/node/app/index.ts";
import type { TodoPrincipal } from "../../principals.ts";

export { Http } from "../../../../../../src/node/http/index.ts";

/** The kit's ephemeral login: `POST /_chord/login { name }` signs in as `{ kind: "user", id, name }`. */
export const login = ephemeralLoginFacet<TodoPrincipal>();
