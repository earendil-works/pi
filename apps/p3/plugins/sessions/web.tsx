// The sessions plugin's web facet: what the session kind has once on the page (`ThingParts`): its icon. Its view is
// the transcript plugin's; its create step comes with slice 5's session kind.

import { defineFacet } from "@earendil-works/p3/v1";
import { CodeIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { ThingParts } from "../things/contract.web.tsx";

export default defineFacet((_host, self) => self.contribute(ThingParts, { kind: "sessions.session", Icon: CodeIcon }));
