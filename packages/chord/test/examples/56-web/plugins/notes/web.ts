// The notes plugin's web facet: a panel on the board page.

import { defineFacet } from "@board/app/v1";
import { Panels } from "@board/app/v1/web";

export default defineFacet((_host, self) => self.contribute(Panels, { title: "Notes", text: "Buy milk" }));
