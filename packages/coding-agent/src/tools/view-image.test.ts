import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { viewImageTool } from "./view-image.js";

// 1x1 transparent PNG
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAp3GZ7sAAAAASUVORK5CYII=";

describe("view_image tool", () => {
	let tempDir: string | null = null;
	let originalCwd: string | null = null;

	afterEach(async () => {
		if (originalCwd) {
			process.chdir(originalCwd);
			originalCwd = null;
		}
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("returns an image content block with base64 data", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mu-view-image-"));
		originalCwd = process.cwd();
		process.chdir(tempDir);

		const imgPath = join(tempDir, "pixel.png");
		await writeFile(imgPath, Buffer.from(PNG_BASE64, "base64"));

		const result = await viewImageTool.execute("toolcall_1", { path: "pixel.png" });
		const image = result.content.find((c) => c.type === "image");
		expect(image).toBeTruthy();
		expect(image && image.type === "image" ? image.mimeType : null).toBe("image/png");
		expect(image && image.type === "image" ? image.data : null).toBe(PNG_BASE64);
	});
});
