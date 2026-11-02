// The sessions plugin's worker facet: its process id, and `crash`, which ends the process (a bug, an out-of-memory).

import { constant, defineFacet } from "@earendil-works/chord/next";
import { Process } from "./contract.ts";

export default defineFacet((host) =>
	host.serve(Process, () => ({
		variant: "main",
		members: {
			pid: constant(process.pid),
			crash: async () => {
				setTimeout(() => process.exit(13), 10);
				return null;
			},
		},
	})),
);
