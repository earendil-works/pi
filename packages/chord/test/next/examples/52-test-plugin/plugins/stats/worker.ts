// The stats plugin's worker facet: words per project over the notes plugin's `Notes`, an indexer contributed to the
// workers' `Indexers` registry, and tags over a `Tags` contract (the tags plugin's; this example's test stubs none).

import { defineFacet, int, local, str } from "@acme/app/v3";
import { Indexers } from "@acme/app/v3/worker";
import { Notes } from "../notes/contract.ts";

/** Words per project. */
const Stats = local("acme.stats", { version: 1, params: { project: str() }, members: { words: int() } });

/** The tags plugin's contract, as this plugin uses it. */
const Tags = local("acme.tags", { version: 1, params: { project: str() }, members: { list: str() } });

/** The tags of a project, as this plugin shows them. */
const TagLine = local("acme.tag-line", { version: 1, params: { project: str() }, members: { text: str() } });

export default defineFacet((host, self) => {
	self.contribute(Indexers, { name: "word count" });
	host.serve(Stats, ({ project }, self) => {
		const notes = self.get(Notes, { project });
		return { words: self.derive([notes.text], ([text]) => text.split(/\s+/).filter(Boolean).length) };
	});
	host.serve(TagLine, ({ project }, self) => {
		const tags = self.get(Tags, { project });
		return { text: self.derive([tags.list], ([list]) => `tags: ${list}`) };
	});
});
