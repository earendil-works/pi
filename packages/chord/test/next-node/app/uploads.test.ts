// Tests of chunked uploads on their own (slice 13 §4): the cap of uploads under way, a slot freed by expiry or by the
// object's end, the files of ended uploads removed. Their use through `Files` (pipelined appends, finish waiting for
// writes, caps) is in `files.test.ts`.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Uploads } from "../../../src/next-node/app/uploads.ts";
import { tempDir } from "./support.ts";

describe("uploads under way", () => {
	it("refuses a begin past the cap busy; an expired upload frees its slot and its file (recheck N1)", async () => {
		const run = join(await tempDir(), "run");
		const uploads = new Uploads(run, 1);
		const first = await uploads.begin("a", "x");
		await expect(uploads.begin("b", "x")).rejects.toMatchObject({ code: "unavailable", reason: "busy" });
		await uploads.expire(60_000);
		expect(await uploads.uploaded(first)).toBe(0);
		await uploads.expire(0);
		await expect(uploads.uploaded(first)).rejects.toMatchObject({ code: "invalid" });
		const second = await uploads.begin("b", "x");
		expect(await readdir(run)).toEqual([second]);
		await uploads.close();
		expect(await readdir(run)).toEqual([]);
		expect(await uploads.begin("c", "x")).toEqual(expect.any(String));
		await uploads.close();
	});
});
