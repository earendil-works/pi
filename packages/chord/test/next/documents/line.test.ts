// The line (§9): holders run one at a time in the order they asked; a release given twice changes nothing.

import { describe, expect, it } from "vitest";
import { Line } from "../../../src/next/documents/line.ts";
import { flushed } from "../support.ts";

describe("the line", () => {
	it("hands the line to each holder in the order they asked, once the previous one released", async () => {
		const line = new Line();
		const order: string[] = [];
		const first = await line.acquire();
		const second = line.acquire().then((release) => {
			order.push("second");
			return release;
		});
		const third = line.acquire().then((release) => {
			order.push("third");
			return release;
		});
		await flushed();
		expect(order).toEqual([]);
		first();
		(await second)();
		await third;
		expect(order).toEqual(["second", "third"]);
	});

	it("ignores a second release of the same holder", async () => {
		const line = new Line();
		const first = await line.acquire();
		const second = line.acquire();
		let thirdHeld = false;
		const third = line.acquire().then(() => {
			thirdHeld = true;
		});
		first();
		first();
		await second;
		await flushed();
		expect(thirdHeld).toBe(false);
		(await second)();
		await third;
		expect(thirdHeld).toBe(true);
	});
});
