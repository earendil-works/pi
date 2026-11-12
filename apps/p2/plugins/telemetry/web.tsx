// The owner's telemetry (web): the Traces view kind (a pane of the session's views), the Traces section of Settings
// (the same browser, its open trace a layer of the sheet), and the command menu's "Show traces" (a view of the open
// session, else the Settings section). Owners only: guests get no command or section, and the pane says so.
import { BACKGROUND_CONTEXT, contribute, defineFacet, withHeld } from "@p2/app/v1";
import {
	type CommandContext,
	Commands,
	closeLayers,
	getNavigation,
	ListIcon,
	openSettings,
	SettingsSections,
	Sheet,
	useOwner,
	useSheet,
} from "@p2/app/v1/web";
import { useState } from "react";
import { Views } from "../views/contract.ts";
import { ViewsPages } from "../views/contract.web.ts";
import { ViewKinds } from "../views/kinds.ts";
import { TracesBrowser } from "./traces.tsx";
import "./traces.css";

/** The view kind and the Settings sheet layer's name. */
const TRACES = "traces";

/** The Traces view's pane: the browser, its open trace the pane's own. */
function TracesPane() {
	const owner = useOwner();
	const [open, setOpen] = useState<string>();
	if (!owner) return <p className="empty-note">Traces are the owner's.</p>;
	return <TracesBrowser open={open} onOpen={setOpen} onBack={() => setOpen(undefined)} />;
}

/** The Traces section of Settings while it is open (the owner): a trace opens as a layer above the list. */
function TracesSheetSlot() {
	const sheet = useSheet(TRACES);
	if (!useOwner() || !sheet) return null;
	const nav = getNavigation();
	return (
		<Sheet title="Traces" onClose={closeLayers} className="traces-sheet">
			<TracesBrowser
				open={sheet.locator}
				onOpen={(traceId) =>
					void nav.push({
						...nav.route,
						layers: [...nav.route.layers, { kind: "sheet", name: TRACES, locator: traceId }],
					})
				}
				onBack={() => void nav.close((route) => ({ ...route, layers: route.layers.slice(0, -1) }))}
			/>
		</Sheet>
	);
}

/** Opens the Traces view in the open session (in front, for everyone in it), else the Settings section. */
async function showTraces(ctx: CommandContext): Promise<void> {
	const session = ctx.route.session;
	const page = (await ctx.host.registry(ViewsPages, BACKGROUND_CONTEXT)).value.get("views");
	if (session === undefined || page === undefined) {
		openSettings({ layer: { kind: "sheet", name: TRACES } });
		return;
	}
	await withHeld(ctx.host.hold(Views, { session }, BACKGROUND_CONTEXT), "editor", (editor) =>
		page.open(editor, session, { kind: TRACES, title: "Traces" }),
	);
}

export default defineFacet((host) => {
	contribute(host, "p2.web-telemetry", (self) => {
		self.contribute(ViewKinds, { [TRACES]: { Pane: TracesPane } });
		self.contribute(SettingsSections, { [TRACES]: { label: "Traces", order: 85, Sheet: TracesSheetSlot } });
		self.contribute(Commands, {
			"telemetry.traces": {
				title: "Show traces",
				group: "Diagnostics",
				order: 90,
				icon: ListIcon,
				keywords: ["telemetry", "spans", "trace", "timing"],
				owner: true,
				action: { kind: "run", run: showTraces },
			},
		});
	});
});
