// What the server tells and asks a session worker (browser-safe): its spawn parameters and the lifecycle calls a
// relocation makes. The worker serves `WorkerBoundary` (worker.ts); the sessions plugin on the server calls it.
import { method, remote } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { arr, bool, nul, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { param, sessionHost } from "./chord.ts";
import { LocationSchema } from "./location.ts";

/** What the server tells a worker it spawns: `session` from the sessions plugin, more keys from other plugins. */
export type SessionInit = {
	readonly id: string;
	readonly cwd: string;
	readonly env?: string | null;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** False for an archived session started only to rebuild its search index: Durable work does not resume. */
	readonly resume?: boolean;
};
export const WorkerBoundary = remote("p2.worker-boundary", {
	version: 2,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		server: {
			methods: {
				/**
				 * Fences admissions if nothing runs (`accepted`). With `to` (a relocation), the `RelocationChecks` run under the
				 * fence too: a `refusal` lifts it again, before anything (the catalog included) moved.
				 */
				prepare: method(
					union([nul(), obj({ to: LocationSchema })]),
					obj({
						accepted: bool(),
						tasks: num(),
						busy: arr(num()),
						refusal: opt(str()),
					}),
				),
				cancel: method(),
				/**
				 * After an accepted `prepare` and the catalog update: the worker follows the session to `location` in place
				 * (`Harness.relocate`), then admits again. A failure leaves it fenced; the server restarts it.
				 */
				relocate: method(LocationSchema),
			},
		},
	},
});
