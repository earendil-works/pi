// A plugin written against v3: the shared module and the server's own module, one version for the whole facet.

import { defineFacet, Greetings } from "@acme/app/v3";
import { serverName } from "@acme/app/v3/server";

export default defineFacet((_host, self) => self.contribute(Greetings, `hello from a v3 plugin on ${serverName()}`));
