// Bob's stats plugin (the user's root): counts words with `@bob/words`, a dependency pinned to a git commit. The build
// inlines the package at the installed commit, whatever the repository holds since.

import { constant, defineFacet, local, str } from "@acme/app/v3";
import { VERSION, words } from "@bob/words";

const Stats = local("bob.stats", { version: 1, params: {}, members: { text: str() } });

export default defineFacet((host) =>
	host.serve(Stats, () => ({ text: constant(`${words("buy milk, call bob")} words (@bob/words ${VERSION})`) })),
);
