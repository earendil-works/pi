// The peek plugin's server facet reaches a web file through its helper: refused at build, naming the chain.

import { defineFacet } from "@acme/app/v3";
import { notesPanel } from "./view.ts";

export default defineFacet(() => console.log(notesPanel));
