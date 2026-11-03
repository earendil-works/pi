// Another single-file plugin: a line naming the server, through the server's module of the API.

import { constant, defineFacet, local, str } from "@acme/app/v3";
import { serverName } from "@acme/app/v3/server";

const Clock = local("example.clock", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) => host.serve(Clock, () => ({ text: constant(`ticking on ${serverName()}`) })));
