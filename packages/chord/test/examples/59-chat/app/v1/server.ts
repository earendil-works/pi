// The chat's API v1 for server facets (`@chat/app/v1/server`): the HTTP registry, and the kit's pick-a-name login as a
// facet its one-line plugin exports.

import { ephemeralLoginFacet } from "../../../../../src/node/app/index.ts";
import type { ChatPrincipal } from "../principals.ts";

export { Http } from "../../../../../src/node/http/index.ts";

/** The kit's ephemeral login: `POST /_chord/login { name }` signs in as `{ kind: "user", id, name }`. */
export const login = ephemeralLoginFacet<ChatPrincipal>();
