// French on pages.

import { defineFacet, Translations } from "@todo/app/v1";
import { french } from "./fr.ts";

export default defineFacet((_host, self) => self.contribute(Translations, french));
