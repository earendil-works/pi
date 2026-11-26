// The faux login on the page, for tests only: its icon among a session's things (it has no view of its own).

import { defineFacet } from "@earendil-works/p3/v1";
import { SmartToyIcon, ThingViews } from "@earendil-works/p3/v1/web";
import { FauxLogin } from "./contract.ts";

export default defineFacet((_host, self) => self.contribute(ThingViews, { kind: FauxLogin.name, Icon: SmartToyIcon }));
