// The sessions plugin's web facet: what the session kind has once on the page (`ThingParts`: its icon and its create
// step, `new-session.tsx`) and its texts. Its view is the transcript plugin's.

import { defineFacet, Translations } from "@earendil-works/p3/v1";
import { SettingsIcon } from "@earendil-works/p3/v1/web";
// Other plugins' web contracts by path, never through `/v1/web`: a plugin applied to a running server meets the base
// its page started with, whose `/v1/web` may not have a newer contract yet.
import { ThingParts } from "../things/contract.web.tsx";
import { SessionDefaultsKind, SessionKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { SessionCreate, SessionIcon } from "./new-session.tsx";

export default defineFacet((_host, self) => {
	self.contribute(ThingParts, [
		{ kind: SessionKind.name, title: messages.message("kindSession"), Icon: SessionIcon, Create: SessionCreate },
		{ kind: SessionDefaultsKind.name, title: messages.message("kindDefaults"), Icon: SettingsIcon },
	]);
	self.contribute(Translations, messages.translations);
});
