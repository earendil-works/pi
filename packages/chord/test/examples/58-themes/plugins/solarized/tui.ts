// The Solarized theme in terminals.

import { defineFacet, Themes } from "@board/app/v1";
import { solarized } from "./theme.ts";

export default defineFacet((_host, self) => self.contribute(Themes, solarized));
