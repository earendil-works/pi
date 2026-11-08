// Tests of chunked uploads on their own (slice 13 §4): the cap of uploads under way, a slot freed by expiry or by the
// object's end, the files of ended uploads removed. Their use through `Files` (pipelined appends, finish waiting for
// writes, caps) is in `files.test.ts`. Each upload carries its owner's data, found and given back.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Uploads } from "../../../src/node/app/uploads.ts";
import { tempDir } from "./support.ts";

describe("uploads under way", () => {
	it("refuses a begin past the cap busy; an expired upload frees its slot and its file (recheck N1)", async () => {
		const run = join(await tempDir(), "run");
		const uploads = new Uploads<string>(run, 1);
		const first = await uploads.begin("a");
		await expect(uploads.begin("b")).rejects.toMatchObject({ code: "unavailable", reason: "busy" });
		await uploads.expire(60_000);
		expect(await uploads.uploaded(first)).toBe(0);
		await uploads.expire(0);
		await expect(uploads.uploaded(first)).rejects.toMatchObject({ code: "invalid" });
		const second = await uploads.begin("b");
		expect(await readdir(run)).toEqual([second]);
		await uploads.close();
		expect(await readdir(run)).toEqual([]);
		expect(await uploads.begin("c")).toEqual(expect.any(String));
		await uploads.close();
	});

	it("finds an upload under way by its data and gives the data back when it finishes", async () => {
		const run = join(await tempDir(), "run");
		const uploads = new Uploads<{ key: string }>(run, 4);
		const id = await uploads.begin({ key: "k1" });
		expect(uploads.find((data) => data.key === "k1")).toBe(id);
		expect(uploads.find((data) => data.key === "k2")).toBeUndefined();
		await uploads.append(id, 0, new TextEncoder().encode("abc"), () => {});
		expect(await uploads.finish(id, join(run, "done"))).toEqual({ data: { key: "k1" }, size: 3 });
		expect(uploads.find((data) => data.key === "k1")).toBeUndefined();
		// A writer that gives up: its upload and its file go.
		const dropped = await uploads.begin({ key: "k3" });
		await uploads.cancel(dropped);
		await uploads.cancel(dropped);
		expect(uploads.find((data) => data.key === "k3")).toBeUndefined();
		expect(await readdir(run)).toEqual(["done"]);
		await uploads.close();
	});
});
