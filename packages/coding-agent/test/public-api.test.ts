import { describe, expect, test } from "vitest";
import { type Args, convertToPng, parseArgs } from "../src/index.ts";

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

describe("public API", () => {
	test("exports parseArgs and Args", () => {
		const parsed: Args = parseArgs(["--print", "hello"]);

		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["hello"]);
	});

	test("exports convertToPng", async () => {
		await expect(convertToPng(TINY_PNG, "image/png")).resolves.toEqual({
			data: TINY_PNG,
			mimeType: "image/png",
		});
	});
});
