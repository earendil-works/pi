import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cropForZoom, diffImages } from "../src/image.ts";
import { ShotStore } from "../src/store.ts";

describe("shotd tools (image layer, no browser)", () => {
	it("diff catches one-pixel-class change", async () => {
		const dir = mkdtempSync(join(tmpdir(), "shotd-diff-"));
		try {
			const a = await sharp({
				create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 255, b: 255 } },
			})
				.png()
				.toBuffer();
			const b = await sharp(a)
				.composite([
					{ input: Buffer.from("<svg><rect width='4' height='4' fill='red'/></svg>"), gravity: "northwest" },
				])
				.png()
				.toBuffer();
			const same = await diffImages(a, a, { threshold: 0.001 });
			expect(same.passed).toBe(true);
			const changed = await diffImages(a, b, { threshold: 0.00001 });
			expect(changed.passed).toBe(false);
			expect(changed.changedPixels).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("zoom respects maxLongEdge", async () => {
		const dir = mkdtempSync(join(tmpdir(), "shotd-zoom-"));
		try {
			const store = new ShotStore(dir);
			const buf = await sharp({
				create: { width: 3840, height: 2160, channels: 3, background: { r: 10, g: 20, b: 30 } },
			})
				.png()
				.toBuffer();
			const rec = store.save(buf, { width: 3840, height: 2160, format: "png" });
			const zoomed = await cropForZoom(
				store.read(rec.path),
				{ x: 0, y: 0, width: 3840, height: 2160 },
				{ maxLongEdge: 1568 },
			);
			const meta = await sharp(zoomed).metadata();
			const long = Math.max(meta.width ?? 0, meta.height ?? 0);
			expect(long).toBeLessThanOrEqual(1568);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
