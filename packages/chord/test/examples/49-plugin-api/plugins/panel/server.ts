// A server facet importing the web's module of the API: refused, naming the kind (a page's registry has no place on
// the server).

import { defineFacet } from "@acme/app/v3";
import { Panels } from "@acme/app/v3/web";

export default defineFacet((_host, self) => self.contribute(Panels, { title: "a panel" }));
