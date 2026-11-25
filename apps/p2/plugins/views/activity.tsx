// How the view tools show in the chat (nested in code mode's card): what each did with which view ("Opened view
// Notes").
import { detailsOf, failureOf, type Step, stringOf, type ToolActivity } from "@p2/app/v1/web";

/** The view a call names: its title once it answered, else what it asked for. */
const objectOf = (step: Step): string => {
	const details = detailsOf(step.tool);
	const args = step.tool.args;
	return (
		stringOf(details.title) ||
		stringOf(args.title) ||
		stringOf(args.id) ||
		stringOf(args.item) ||
		stringOf(details.id)
	);
};

/** The activity of one view tool: its past and present words, naming the view when `named`. */
function viewTool(done: string, doing: string, named: boolean, kind: "read" | "artifact"): ToolActivity {
	return {
		brief: "Using views",
		describe(step) {
			const object = named ? objectOf(step) : "";
			return {
				label: { kind, verb: done, ...(object ? { object, style: "words" as const } : {}) },
				...(failureOf(step) ? { description: failureOf(step) } : {}),
			};
		},
		running(step) {
			const object = named ? objectOf(step) : "";
			return { kind, verb: doing, ...(object ? { object, style: "words" as const } : {}) };
		},
		argument: (tool) =>
			named ? stringOf(tool.args.title) || stringOf(tool.args.id) || stringOf(tool.args.item) : "",
		summary: (count) => (count === 1 ? "used a view" : `used views ${count} times`),
	};
}

/** The view tools' activities, by tool name. */
export const VIEW_ACTIVITIES: Readonly<Record<string, ToolActivity>> = {
	view_list: viewTool("Listed views", "Listing views", false, "read"),
	view_open: viewTool("Opened view", "Opening view", true, "artifact"),
	view_close: viewTool("Closed view", "Closing view", true, "artifact"),
	view_arrange: viewTool("Arranged views", "Arranging views", false, "artifact"),
	view_resolve: viewTool("Resolved annotations", "Resolving annotations", false, "artifact"),
};
