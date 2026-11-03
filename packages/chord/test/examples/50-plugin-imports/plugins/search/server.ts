// The search plugin's server facet: uses the notes plugin's contract, imported by relative path (same root, same
// commit: a copy of that file in this script).

import { defineFacet, int, local } from "@acme/app/v3";
import { Notes } from "../notes/contract.ts";

const Search = local("acme.search", { version: 1, params: {}, members: { hits: int() } });

export default defineFacet((host) =>
	host.serve(Search, (_params, self) => {
		const notes = self.get(Notes, {});
		return { hits: self.derive([notes.text], ([text]) => text.split(",").length) };
	}),
);
