// A terminal's link on the page (terminal-link.ts), over a stand-in of the held Terminals: a person refused at
// attaching (the terminal gone, Watch and Use withheld) or without the member is told the link will not connect, so
// the screen says so instead of "Connecting…" (Astra, round 4).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invalid, type Reference } from "@earendil-works/p3/v1";
import type { Terminals } from "../kind.ts";
import type { ScreenFeed } from "../screen.ts";
import { terminalLink } from "../terminal-link.ts";

/** A feed that records whether it was told the connection was lost, and whether it comes again. */
function feed() {
	const lost: boolean[] = [];
	const told = Promise.withResolvers<void>();
	const recording: ScreenFeed = {
		restart: () => {},
		output: () => {},
		size: () => {},
		answer: () => {},
		from: () => {},
		lost: (again) => {
			lost.push(again);
			told.resolve();
		},
	};
	return { recording, lost, told: told.promise };
}

describe("a terminal's link", () => {
	it("says it will not connect when attaching is refused, or not given", async () => {
		const refused = {
			attach: async () => {
				throw invalid("args", "terminals: no terminal t");
			},
		};
		const none = {};
		for (const live of [refused, none]) {
			const { recording, lost, told } = feed();
			// The link reads `attach` and `type` of the reference only.
			const stop = terminalLink(live as unknown as Reference<typeof Terminals>, "t").follow(recording);
			await told;
			stop();
			assert.deepEqual(lost, [false]);
		}
	});
});
