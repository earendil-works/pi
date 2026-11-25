// The Familiar's `sidebar_rollups` tool (worker, the Familiar's session only): lists the rollups made from code, tries a
// script against the sessions now, saves, refreshes and removes rollups. The owner sees a saved rollup in the sidebar.
import { schemaToType } from "@earendil-works/pi-codemode";
import { defineExtension } from "@earendil-works/pi-durable";
import { obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { type Ctx, defineFacet, expectVariant, literal, local, type RefIn } from "@p2/app/v1";
import { defineP2Tool, Extensions, type P2Tool, type WorkerParts, workerOf } from "@p2/app/v1/worker";
import { FAMILIAR_INIT } from "../familiar/contract.ts";
import {
	type Preview,
	RefreshSchema,
	ROLLUPS_TOOL,
	type RollupEntry,
	RollupOutputSchema,
	RollupSessionSchema,
	RollupWindowSchema,
	SidebarRollups,
} from "./contract.ts";

const PARAMETERS = obj({
	action: union([literal("list"), literal("preview"), literal("save"), literal("refresh"), literal("remove")]),
	key: opt(str()),
	name: opt(str()),
	window: opt(RollupWindowSchema),
	refresh: opt(RefreshSchema),
	code: opt(str()),
});
type ToolArgs = Static<typeof PARAMETERS>;

const DESCRIPTION = [
	"Manage the rollups of the owner's sidebar that are made from code. A rollup is a script over every session that returns one section of the sidebar.",
	"list: the saved rollups with their last result. preview (code): run a script against the sessions now, without saving; check its output before saving.",
	"save (key, name, code; optional window, refresh): save a rollup and run it once; the same key replaces it. refresh (key): run it now. remove (key).",
	"",
	"The script is a code mode script body without tools: it reads `sessions` (every session but yours, archived ones included, oldest first), `projects` and `now()`, and returns the rollup.",
	'For what conversations say: `await mentions(query, { since })` gives { [sessionId]: time of its latest matching message } over every session\'s user and assistant messages (subagents included; not tool output or thinking), from the search index in one query. Query: words, all required; "a phrase"; prefix*. Words, not substrings: "p2" matches "apps/p2" and "P2", not "p2x".',
	'For a recent mention, return { id, at } with `at` the mention\'s time and a window ("1d") rather than since + now(): the window keeps the cutoff current without reading now().',
	`Each session: ${schemaToType(RollupSessionSchema)}`,
	`It returns: ${schemaToType(RollupOutputSchema)}`,
	"A member is a session ID, or { id, at, keep }: `at` is the time the window compares and the list sorts by (default the session's updatedAt), `keep` shows it whatever its time.",
	"Archived sessions are never shown, and unknown IDs are dropped. Pinned, open, working, unread and failed sessions always show; a group shows while it has a session to show, or with keep.",
	'window (default "3d"): "1d" | "3d" | "1w" | "forever", which the owner can change, or "none": every member shows.',
	'refresh (default { kind: "auto" }): auto (runs again when a field the script read changed), { kind: "every", minutes } (on that interval, when something it read changed), or manual. The owner can refresh any rollup by hand.',
	"Read only the fields you need: reading now() makes every refresh run the script. A script that calls mentions runs again when what the call answers changes.",
].join("\n");

const RollupTools = local("p2.rollup-tools", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(RollupTools, (_params, self) => {
		const worker = workerOf(self);
		if (worker().init.values[FAMILIAR_INIT] !== true) return {};
		const extension = rollupsExtension(worker);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});

/** The `sidebar_rollups` tool, calling the server's rollups as the Familiar's worker. */
function rollupsExtension(worker: () => WorkerParts) {
	return defineExtension<P2Tool>({
		name: "p2-rollups",
		tools: [
			defineP2Tool({
				name: ROLLUPS_TOOL,
				description: DESCRIPTION,
				parameters: PARAMETERS,
				replay: "safe",
				scope: "main",
				execute: async (args, _api, context) => {
					const reply = (text: string, isError = false) => ({
						output: [{ type: "text" as const, text }],
						details: { action: args.action, ...(args.key === undefined ? {} : { key: args.key }) },
						isError,
					});
					try {
						const text = await worker().root(async (ctx) => {
							const rollups = expectVariant(await ctx.get(SidebarRollups, {}), "familiar");
							return act(args, rollups, ctx);
						}, context);
						return reply(text);
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						return reply(error instanceof Error ? error.message : String(error), true);
					}
				},
			}),
		],
	});
}

/** The tool's text for `args`: one action on the server's rollups. */
async function act(args: ToolArgs, rollups: RefIn<typeof SidebarRollups, "familiar">, ctx: Ctx): Promise<string> {
	switch (args.action) {
		case "list": {
			const entries = await rollups.list(ctx);
			return entries.length ? entries.map(describe).join("\n\n") : "No rollups made from code yet.";
		}
		case "preview":
			if (!args.code) throw new Error("preview needs code");
			return previewText(await rollups.preview({ code: args.code }, ctx));
		case "save": {
			if (!args.key || !args.name || !args.code) throw new Error("save needs key, name and code");
			const entry = await rollups.save(
				{
					key: args.key,
					name: args.name,
					code: args.code,
					window: args.window ?? "3d",
					refresh: args.refresh ?? { kind: "auto" },
				},
				ctx,
			);
			return `Saved.\n${describe(entry)}`;
		}
		case "refresh":
			if (!args.key) throw new Error("refresh needs a key");
			return describe(await rollups.refresh({ key: args.key }, ctx));
		case "remove":
			if (!args.key) throw new Error("remove needs a key");
			await rollups.remove({ key: args.key }, ctx);
			return `Removed ${args.key}.`;
	}
}

/** A saved rollup in short: key, name, window, refresh, its last result, and its code. */
function describe(entry: RollupEntry): string {
	const { key, name, window, refresh, code } = entry.definition;
	const every = refresh.kind === "every" ? `every ${refresh.minutes} min` : refresh.kind;
	return [
		`${key} · ${JSON.stringify(name)} · window ${window} · refresh ${every}`,
		entry.error ? `Last run failed: ${entry.error}` : undefined,
		entry.output
			? `Output: ${summary(entry.output)}; reads ${entry.reads.join(", ") || "nothing"}`
			: "No output yet.",
		"```js",
		code,
		"```",
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

/** A preview's output, in short and as JSON (cut), with what it read; a failed preview throws why. */
function previewText(preview: Preview): string {
	if (!preview.ok) throw new Error(preview.error);
	return `Output: ${summary(preview.output)}\nReads: ${preview.reads.join(", ") || "nothing"}\n${JSON.stringify(preview.output).slice(0, 4000)}`;
}

/** An output in short: its layout and how many sessions (or groups) it has. */
function summary(output: NonNullable<RollupEntry["output"]>): string {
	if (output.layout === "groups")
		return `${output.groups.length} groups (${output.groups.map((group) => `${group.name}: ${group.members.length}`).join(", ")})`;
	return `${output.layout}, ${output.members.length} sessions`;
}
