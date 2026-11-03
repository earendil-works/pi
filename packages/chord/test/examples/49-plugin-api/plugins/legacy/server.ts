// A plugin written against v2 a year ago: the app still lists v2, so it builds and runs, through v2's names.

import { defineFacet, Hellos } from "@acme/app/v2";

export default defineFacet((_host, self) => self.contribute(Hellos, "hello from a v2 plugin"));
