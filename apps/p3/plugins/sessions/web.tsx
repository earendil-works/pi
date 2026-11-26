// The sessions plugin's web facet: what the session kind has once on the page (`ThingParts`: its icon and its create
// step, `new-session.tsx`) and its texts. Its view is the transcript plugin's.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { ThingParts } from "../things/contract.web.tsx";
import { SessionKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { SessionCreate, SessionIcon } from "./new-session.tsx";

export default defineFacet((_host, self) => {
	self.contribute(ThingParts, { kind: SessionKind.name, Icon: SessionIcon, Create: SessionCreate });
	self.contribute(Translations, messages.translations);
});
