// The search plugin's web facet: imports the notes plugin's web contract file, which web facets may.

import { defineFacet } from "@acme/app/v3";
import { Panels } from "@acme/app/v3/web";
import { notesPanel } from "../notes/contract.web.ts";

export default defineFacet((_host, self) => self.contribute(Panels, { title: `search ${notesPanel.title}` }));
