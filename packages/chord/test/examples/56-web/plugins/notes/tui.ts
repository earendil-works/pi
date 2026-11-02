// The notes plugin's terminal facet: a line on the terminal board.

import { defineFacet } from "@board/app/v1";
import { Lines } from "@board/app/v1/tui";

export default defineFacet((_host, self) => self.contribute(Lines, "Notes: Buy milk"));
