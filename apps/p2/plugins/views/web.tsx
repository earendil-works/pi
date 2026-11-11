// Views (web): the workbench in place of the bare chat, the built-in view kinds, the top bar's controls, the composer's
// chip, the `view` tool's activity and the note on messages that carried view context.
import { contribute, defineFacet, serveKeyed } from "@p2/app/v1";
import { Slots, ToolActivities } from "@p2/app/v1/web";
import { TranscriptEntries } from "../chat/contract.ts";
import { viewActivity } from "./activity.tsx";
import { VIEW_INPUT } from "./contract.ts";
import { ViewKinds } from "./kinds.ts";
import { ChangesPane, CustomPane, MarkdownPane } from "./panes.tsx";
import { ContextChip, ViewActions } from "./sheet.tsx";
import "./views.css";
import { viewInputDisplay } from "./display.ts";
import { Workbench } from "./Workbench.tsx";

export default defineFacet((host) => {
	serveKeyed(host, ViewKinds);
	contribute(host, "p2.web-views", (self) => {
		self.contribute(Slots, { workbench: Workbench, "view-actions": ViewActions, "composer:views": ContextChip });
		self.contribute(ViewKinds, { markdown: MarkdownPane, changes: ChangesPane, custom: CustomPane });
		self.contribute(ToolActivities, { view: viewActivity });
		self.contribute(TranscriptEntries, { [VIEW_INPUT]: viewInputDisplay });
	});
});
