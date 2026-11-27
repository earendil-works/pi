// The sessions plugin on the server: its store (`store.ts`: where each session works, its state, its model; each
// defaults thing's settings), the session kind (`session.ts`: a session is a session workspace), the session defaults
// kind (`defaults.ts`), the waker (`waker.ts`), a worker's facts (`facts.ts`) and what its agent is given
// (`agent-things.ts`). Who may do what in a session is the things plugin's: its workspace's grants.

import { defineFacet } from "@earendil-works/p3/v1";
import { serveAgentThings } from "./agent-things.ts";
import { serveDefaultsKind } from "./defaults.ts";
import { serveFacts } from "./facts.ts";
import { serveSessionKind } from "./session.ts";
import { serveStore } from "./store.ts";
import { serveWaker } from "./waker.ts";

export default defineFacet((host) => {
	serveStore(host);
	serveSessionKind(host);
	serveDefaultsKind(host);
	serveWaker(host);
	serveFacts(host);
	serveAgentThings(host);
});
