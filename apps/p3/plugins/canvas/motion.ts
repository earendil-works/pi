// A board's motion on the server (`BoardMotion`): the relay of what everyone holding a board in one workspace does on
// it, pointers and the shapes being drawn, as events. Each holder's object (`server.ts`) sends its caller's motion
// here and hands out `motion`; nothing is stored, and a lost event is replaced by the next.

import { event, type FacetHost, local, method, type P3Principal, str } from "@earendil-works/p3/v1";
import { Motion } from "./kind.ts";

/**
 * One board's motion in one workspace: what everyone holding it there does on it (`motion`, events), and `send`,
 * which each holder's object calls with its caller's motion. Per workspace: a board linked in two shows each
 * workspace's people only to that workspace's.
 */
export const BoardMotion = local("canvas.motion", {
	version: 2,
	params: { workspace: str(), thing: str() },
	members: { motion: event(Motion), send: method(Motion) },
});

/** Serves `BoardMotion` on `host`. */
export function serveMotion(host: FacetHost<P3Principal>): void {
	host.serve(BoardMotion, (_params, self) => {
		const motion = self.events<Motion>();
		return {
			motion,
			send: async (value) => {
				motion.emit(value);
				return null;
			},
		};
	});
}
