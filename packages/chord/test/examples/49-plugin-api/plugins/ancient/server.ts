// A plugin written against v1, which the app no longer provides: refused at build, naming the versions it has.

import { defineFacet, Greetings } from "@acme/app/v1";

export default defineFacet((_host, self) => self.contribute(Greetings, "hello from v1"));
