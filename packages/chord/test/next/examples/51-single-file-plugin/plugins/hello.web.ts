// The same plugin's web facet: a second file with the same first name.

import { defineFacet } from "@acme/app/v3";
import { Panels } from "@acme/app/v3/web";

export default defineFacet((_host, self) => self.contribute(Panels, { title: "hello" }));
