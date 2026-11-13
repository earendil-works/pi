// The session selector's message search in the TUI (p2-tui-port.md section 1.17): `Search` is literal and bounded, and
// the owner's; the selector shows its hits as a separate group. `/reindex` rebuilds the viewed session's index.

import { BACKGROUND_CONTEXT, contribute, defineFacet, liveIn, whenLive } from "@p2/app/v1";
import {
	lineText,
	type TuiCommand,
	TuiCommands,
	type TuiContext,
	type TuiSessionSource,
	TuiSessionSources,
} from "@p2/app/v1/tui";
import { Search } from "./contract.ts";

const source: TuiSessionSource = {
	search: (runtime, query, archived) =>
		runtime.host.root(async (root) => {
			const search = await root.get(Search, {});
			if (search.variant !== "owner") return [];
			return (await search.search({ query, archived }, root)).messages;
		}, BACKGROUND_CONTEXT),
};

/**
 * `/reindex`: re-indexes the viewed session's history (`Search.rebuildIndex`). Long work (a job on the server): a
 * line says it runs at once, another when it is done or why it failed (`Search.rebuilds`).
 */
function reindex(ctx: TuiContext): void {
	const session = ctx.identity.session;
	if (!session) return;
	const scope = ctx.scope();
	let started = false;
	const search = scope.watch(Search, {}, (ref, follow) => {
		if (ref.variant !== "owner") return;
		follow(ref.rebuilds, (rebuilds) => {
			const rebuild = rebuilds.find((each) => each.session === session);
			if (!started || rebuild?.phase === "running") return;
			if (rebuild?.phase === "failed")
				ctx.notify(`Search index rebuild failed: ${lineText(rebuild.error)}`, "error");
			else ctx.notify("Search index rebuilt");
			scope.dispose();
		});
	});
	ctx.notify("Rebuilding the search index…");
	void (async () => {
		await whenLive(search);
		const owner = liveIn(search, "owner");
		if (!owner) throw new Error("Only the owner rebuilds the search index");
		await owner.rebuildIndex({ session }, BACKGROUND_CONTEXT);
		started = true;
	})().catch((error: unknown) => {
		ctx.fail(error);
		scope.dispose();
	});
}

const COMMANDS: Record<string, TuiCommand> = {
	"p2.search.reindex": {
		title: "Rebuild the session's search index",
		category: "Owner",
		when: "chat && owner && !overlay",
		slash: { name: "reindex" },
		run: (ctx) => reindex(ctx),
	},
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-search", (self) => {
		self.contribute(TuiSessionSources, { search: source });
		self.contribute(TuiCommands, COMMANDS);
	}),
);
