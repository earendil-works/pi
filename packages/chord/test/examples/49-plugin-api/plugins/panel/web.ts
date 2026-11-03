// The panel plugin's web facet: the web's module of the API is for exactly this kind.

import { defineFacet } from "@acme/app/v3";
import { Panels } from "@acme/app/v3/web";

export default defineFacet((_host, self) => self.contribute(Panels, { title: "word count" }));
