// The Harbor theme in terminals.

import { defineFacet, Themes } from "@todo/app/v1";
import { harbor } from "./theme.ts";

export default defineFacet((_host, self) => self.contribute(Themes, harbor));
