// Tests of live folder listings on their own (decision "Files v2"): a view attaches with the listing read now, a
// change of its space reads each watched folder once and tells its observers, a change during an attach makes it read
// again, and a detached view is never read or told again (nothing kept for it).

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { FollowObserver } from "../../../src/host/index.ts";
import { type FolderListing, FolderViews } from "../../../src/node/app/folder-views.ts";

/** A listing naming `n`, for telling reads apart. */
const listing = (n: number): FolderListing => ({
	entries: [{ kind: "folder", folder: { space: "s", path: `f${n}`, created: n } }],
	more: false,
});

/** An observer recording the values it is told. */
function recorder(): { observer: FollowObserver<unknown>; told: unknown[] } {
	const told: unknown[] = [];
	return {
		told,
		observer: { advance: (call) => told.push(call.kind === "value" ? call.value : call), end: () => {} },
	};
}

describe("folder views", () => {
	it("attaches with the listing now; a change of its space reads each watched folder once", async () => {
		const views = new FolderViews();
		const reads: string[] = [];
		views.bind(async (space, folder) => {
			reads.push(`${space}:${folder}`);
			return listing(reads.length);
		});
		const a = recorder();
		const b = recorder();
		const other = recorder();
		expect((await views.attach("s", "docs", a.observer, context)).value).toEqual(listing(1));
		await views.attach("s", "docs", b.observer, context);
		await views.attach("t", "docs", other.observer, context);
		reads.length = 0;
		await views.changed("s", context);
		expect(reads).toEqual(["s:docs"]);
		expect(a.told).toEqual([listing(1)]);
		expect(b.told).toEqual([listing(1)]);
		expect(other.told).toEqual([]);
	});

	it("reads again when its space changes while it attaches", async () => {
		const views = new FolderViews();
		let reads = 0;
		let changeDuringFirst: (() => Promise<void>) | undefined = () => views.changed("s", context);
		views.bind(async () => {
			reads++;
			const change = changeDuringFirst;
			changeDuringFirst = undefined;
			await change?.();
			return listing(reads);
		});
		const a = recorder();
		expect((await views.attach("s", "", a.observer, context)).value).toEqual(listing(2));
		expect(a.told).toEqual([]);
	});

	it("never reads or tells a detached view again", async () => {
		const views = new FolderViews();
		let reads = 0;
		views.bind(async () => listing(++reads));
		const a = recorder();
		const attached = await views.attach("s", "docs", a.observer, context);
		attached.detach();
		await views.changed("s", context);
		expect(reads).toBe(1);
		expect(a.told).toEqual([]);
	});

	it("keeps nothing of a view whose first read fails", async () => {
		const views = new FolderViews();
		let fail = true;
		let reads = 0;
		views.bind(async () => {
			reads++;
			if (fail) throw new Error("read failed");
			return listing(reads);
		});
		await expect(views.attach("s", "", recorder().observer, context)).rejects.toThrow("read failed");
		fail = false;
		await views.changed("s", context);
		expect(reads).toBe(1);
	});
});
