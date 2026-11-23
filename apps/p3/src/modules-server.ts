// The API's modules the server evaluates its plugins' server facets with, this process's instances by specifier.

import * as v1 from "@earendil-works/p3/v1";
import * as v1server from "@earendil-works/p3/v1/server";

/** The server's API modules by specifier. */
export const SERVER_MODULES = { "@earendil-works/p3/v1": v1, "@earendil-works/p3/v1/server": v1server };
