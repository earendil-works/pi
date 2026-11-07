import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARCHIVE_HEIGHT, ARCHIVE_WIDTH, DSF, VIEWPORT_HEIGHT, VIEWPORT_WIDTH } from "../src/image.ts";
import { ShotStore, sha256 } from "../src/store.ts";

describe("shotd geometry", () => {
	it("1920x1080 @ DSF2 gives 3840x2160 archive", () => {
		expect(VIEWPORT_WIDTH).toBe(1920);
		expect(VIEWPORT_HEIGHT).toBe(1080);
		expect(DSF).toBe(2);
		expect(ARCHIVE_WIDTH).toBe(3840);
		expect(ARCHIVE_HEIGHT).toBe(2160);
	});
	it("store is content-addressed and deterministic", () => {
		const dir = mkdtempSync(join(tmpdir(), "shotd-"));
		try {
			const store = new ShotStore(dir);
			const buf = Buffer.from("hello");
			const r = store.save(buf, { width: 3840, height: 2160, format: "webp" });
			expect(r.sha256).toBe(sha256(buf));
			expect(r.sha256).toBe(sha256(Buffer.from("hello")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
