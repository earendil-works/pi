import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage } from "canvas";
import { afterEach, describe, expect, it } from "vitest";
import { type ReadImageSelfDetails, readImageTool } from "../src/tools/read-image.js";

async function writePng(path: string, width: number, height: number): Promise<void> {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "#336699";
	context.fillRect(0, 0, width, height);
	await writeFile(path, canvas.toBuffer("image/png"));
}

async function getImageDimensions(base64: string): Promise<{ width: number; height: number }> {
	const image = await loadImage(Buffer.from(base64, "base64"));
	return { width: image.width, height: image.height };
}

describe("read_image self mode resize", () => {
	const cleanups: string[] = [];

	afterEach(() => {
		for (const dir of cleanups.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("downscales oversized multi-image self reads to Anthropic-safe dimensions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mu-read-image-self-resize-"));
		cleanups.push(dir);

		const primaryPath = join(dir, "primary.png");
		const referencePath = join(dir, "reference.png");
		await writePng(primaryPath, 2501, 1400);
		await writePng(referencePath, 900, 2405);

		const result = await readImageTool.execute("tool-1", {
			path: primaryPath,
			objective: "Compare layout differences",
			mode: "self",
			referenceFiles: [referencePath],
		});

		expect(result.details?.mode).toBe("self");

		const details = result.details as ReadImageSelfDetails;
		expect(details.images).toHaveLength(2);

		const primary = details.images.find((image) => image.role === "primary");
		const reference = details.images.find((image) => image.role === "reference");
		expect(primary).toBeDefined();
		expect(reference).toBeDefined();

		const primaryDimensions = await getImageDimensions(primary!.base64);
		const referenceDimensions = await getImageDimensions(reference!.base64);

		expect(Math.max(primaryDimensions.width, primaryDimensions.height)).toBeLessThanOrEqual(2000);
		expect(Math.max(referenceDimensions.width, referenceDimensions.height)).toBeLessThanOrEqual(2000);
	});
});
