// The Solarized theme on pages.

import { defineFacet, Themes } from "@board/app/v1";
import { solarized } from "./theme.ts";

export default defineFacet((_host, self) => self.contribute(Themes, solarized));
