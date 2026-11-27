// The election of the viewer that answers a terminal's queries (answering.ts): the first that may type, then the one
// that typed last, then the next when it goes; a viewer that may not type never answers; every change takes effect at
// one offset of the terminal's output for every viewer (Astra, round 3, M1).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Answerer, Answering } from "../answering.ts";

/** A viewer that records what it is told, typable or not. */
function viewer(typable: boolean) {
	const told: [boolean, number][] = [];
	const answerer: Answerer = { typable: () => typable, answer: (yes, at) => void told.push([yes, at]) };
	return { answerer, told };
}

describe("the answering viewer", () => {
	it("changes at one output offset for every viewer, whoever draws it when", () => {
		let end = 100;
		const election = new Answering(() => end);
		const [a, b, watcher] = [viewer(true), viewer(true), viewer(false)];
		election.add(a.answerer);
		election.add(watcher.answerer);
		election.add(b.answerer);
		end = 320_100;
		election.typed(b.answerer);
		assert.deepEqual(a.told, [
			[true, 100],
			[false, 320_100],
		]);
		assert.deepEqual(b.told, [[true, 320_100]]);
		assert.deepEqual(watcher.told, []);
		end = 400_000;
		election.remove(b.answerer);
		assert.deepEqual(a.told.at(-1), [true, 400_000]);
		election.remove(a.answerer);
		assert.equal(election.empty, false, "the watcher is still there");
		election.remove(watcher.answerer);
		assert.equal(election.empty, true);
	});
});
