// Views (web): the workbench in place of the bare chat, the built-in view kinds, the top bar's controls, the composer's
// chip, the view tools' activities, the note on messages that carried view context, and the views' commands of the
// command menu (commands.tsx).
import { contribute, defineFacet, serveKeyed } from "@p2/app/v1";
import { CommandPages, Commands, Slots, ToolActivities } from "@p2/app/v1/web";
import { TranscriptEntries } from "../chat/contract.ts";
import { VIEW_ACTIVITIES } from "./activity.tsx";
import { VIEW_COMMANDS, VIEW_PAGES } from "./commands.tsx";
import { VIEW_INPUT } from "./contract.ts";
import { type ViewsPage, ViewsPages } from "./contract.web.ts";
import { frameHandles, noteSelection, ViewKinds } from "./kinds.ts";
import { annotateMode } from "./layout-store.ts";
import { ChangesPane, MarkdownPane } from "./panes.tsx";
import { ContextChip, openView, ViewActions } from "./sheet.tsx";
import "./views.css";
import { viewInputDisplay } from "./display.ts";
import { Workbench } from "./Workbench.tsx";

/** The views plugin's page state as other plugins' web facets reach it (contract.web.ts). */
const VIEWS_PAGE: ViewsPage = {
	open: openView,
	annotating: () => annotateMode() !== "off",
	frame: (view, handle) => {
		frameHandles.set(view, handle);
		return () => {
			if (frameHandles.get(view) === handle) frameHandles.delete(view);
		};
	},
	noteSelection,
};

export default defineFacet((host) => {
	serveKeyed(host, ViewKinds);
	serveKeyed(host, ViewsPages);
	contribute(host, "p2.web-views", (self) => {
		self.contribute(ViewsPages, { views: VIEWS_PAGE });
		self.contribute(Slots, { workbench: Workbench, "view-actions": ViewActions, "composer:views": ContextChip });
		self.contribute(ViewKinds, { markdown: { Pane: MarkdownPane }, changes: { Pane: ChangesPane } });
		self.contribute(ToolActivities, VIEW_ACTIVITIES);
		self.contribute(TranscriptEntries, { [VIEW_INPUT]: viewInputDisplay });
		self.contribute(Commands, VIEW_COMMANDS);
		self.contribute(CommandPages, VIEW_PAGES);
	});
});
