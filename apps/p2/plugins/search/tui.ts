// The session selector's message search in the TUI (p2-tui-port.md section 1.17): `Search` is literal and bounded, and
// the owner's; the selector shows its hits as a separate group.

import { BACKGROUND_CONTEXT, contribute, defineFacet } from "@p2/app/v1";
import { type TuiSessionSource, TuiSessionSources } from "@p2/app/v1/tui";
import { Search } from "./contract.ts";

const source: TuiSessionSource = {
	search: (runtime, query, archived) =>
		runtime.host.root(async (root) => {
			const search = await root.get(Search, {});
			if (search.variant !== "owner") return [];
			return (await search.search({ query, archived }, root)).messages;
		}, BACKGROUND_CONTEXT),
};

export default defineFacet((host) =>
	contribute(host, "p2.tui-search", (self) => {
		self.contribute(TuiSessionSources, { search: source });
	}),
);
