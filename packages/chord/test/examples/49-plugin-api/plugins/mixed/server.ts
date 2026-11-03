// A facet importing two versions of the API: refused (v2's and v3's registries may be different ones).

import { Hellos } from "@acme/app/v2";
import { defineFacet } from "@acme/app/v3";

export default defineFacet((_host, self) => self.contribute(Hellos, "hello from two versions"));
