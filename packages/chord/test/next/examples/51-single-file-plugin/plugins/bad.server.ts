// A single-file plugin importing another file: refused at build, saying to make it a directory.

import { defineFacet } from "@acme/app/v3";
import { helper } from "./helper.ts";

export default defineFacet(() => console.log(helper));
