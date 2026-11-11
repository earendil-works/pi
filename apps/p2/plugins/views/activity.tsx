// How the `view` tool shows in the chat: what it did with which view ("Opened view Glyph editor").
import { detailsOf, failureOf, type Step, stringOf, type ToolActivity } from "@p2/app/v1/web";

/** Past and present words of each action. */
const WORDS: Record<string, [done: string, doing: string]> = {
	list: ["Listed views", "Listing views"],
	open: ["Opened view", "Opening view"],
	read: ["Read view", "Reading view"],
	update: ["Updated view", "Updating view"],
	close: ["Closed view", "Closing view"],
	resolve: ["Resolved annotations", "Resolving annotations"],
	save: ["Saved view", "Saving view"],
	saved: ["Listed saved views", "Listing saved views"],
	load: ["Loaded view", "Loading view"],
	help: ["Read the views' page API", "Reading the views' page API"],
	arrange: ["Arranged views", "Arranging views"],
};

/** The view a call names: its title once it answered, else what it asked for. */
const objectOf = (step: Step): string => {
	const details = detailsOf(step.tool);
	const args = step.tool.args;
	return (
		stringOf(details.title) ||
		stringOf(args.title) ||
		stringOf(args.id) ||
		stringOf(args.name) ||
		stringOf(details.id)
	);
};

const kindOf = (action: string) => (["read", "list", "saved", "help"].includes(action) ? "read" : "artifact");

export const viewActivity: ToolActivity = {
	brief: "Using views",
	describe(step) {
		const action = stringOf(step.tool.args.action);
		const [verb] = WORDS[action] ?? ["Used views"];
		const object =
			WORDS[action] && !["list", "saved", "resolve", "help", "arrange"].includes(action) ? objectOf(step) : "";
		return {
			label: { kind: kindOf(action), verb, ...(object ? { object, style: "words" as const } : {}) },
			...(failureOf(step) ? { description: failureOf(step) } : {}),
		};
	},
	running(step) {
		const action = stringOf(step.tool.args.action);
		const [, verb] = WORDS[action] ?? ["", "Using views"];
		const object = !["list", "saved", "resolve", "help", "arrange"].includes(action) ? objectOf(step) : "";
		return { kind: kindOf(action), verb, ...(object ? { object, style: "words" as const } : {}) };
	},
	argument: (tool) => stringOf(tool.args.title) || stringOf(tool.args.id) || stringOf(tool.args.action),
	summary: (count) => (count === 1 ? "used a view" : `used views ${count} times`),
};
