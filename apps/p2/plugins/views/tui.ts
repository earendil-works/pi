// Views (TUI): the terminal shows no panes, but a message that carried view context gets its note there too.
import { contribute, defineFacet } from "@p2/app/v1";
import { TranscriptEntries } from "../chat/contract.ts";
import { VIEW_INPUT } from "./contract.ts";
import { viewInputDisplay } from "./display.ts";

export default defineFacet((host) => {
	contribute(host, "p2.tui-views", (self) => {
		self.contribute(TranscriptEntries, { [VIEW_INPUT]: viewInputDisplay });
	});
});
