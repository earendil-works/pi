import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { loadFormImage } from "../src/core/ask/media.ts";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function png(): Buffer {
	const image = new PNG({ width: 12, height: 8 });
	image.data.fill(255);
	return PNG.sync.write(image);
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-ask-media-"));
	directories.push(directory);
	return directory;
}

describe("question form image loading", () => {
	it("reads local and base64 raster images with their real dimensions", async () => {
		const directory = await fixture();
		const bytes = png();
		await writeFile(join(directory, "preview.png"), bytes);
		const local = await loadFormImage("preview.png", directory, new AbortController().signal);
		const data = await loadFormImage(
			`data:image/png;base64,${bytes.toString("base64")}`,
			directory,
			new AbortController().signal,
		);
		expect(getImageDimensions(local.data, local.mimeType)).toEqual({ widthPx: 12, heightPx: 8 });
		expect(data).toEqual(local);
	});

	it("follows bounded HTTP redirects and rejects a non-image response", async () => {
		const bytes = png();
		const server = createServer((request, response) => {
			if (request.url === "/redirect") {
				response.writeHead(302, { location: "/image" });
				response.end();
			} else if (request.url === "/image") {
				response.writeHead(200, { "content-type": "image/png" });
				response.end(bytes);
			} else {
				response.writeHead(200, { "content-type": "text/html" });
				response.end("<script>not an image</script>");
			}
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP test server");
		const result = await loadFormImage(
			`http://127.0.0.1:${address.port}/redirect`,
			"/tmp",
			new AbortController().signal,
		);
		expect(getImageDimensions(result.data, result.mimeType)).toEqual({ widthPx: 12, heightPx: 8 });
		await expect(
			loadFormImage(`http://127.0.0.1:${address.port}/html`, "/tmp", new AbortController().signal),
		).rejects.toThrow("valid PNG");
	});

	it("rejects oversized local files and unsupported document images", async () => {
		const directory = await fixture();
		await writeFile(join(directory, "huge.png"), Buffer.alloc(8 * 1024 * 1024 + 1));
		await expect(loadFormImage("huge.png", directory, new AbortController().signal)).rejects.toThrow("8 MiB");
		await expect(
			loadFormImage("data:image/svg+xml;base64,PHN2Zy8+", directory, new AbortController().signal),
		).rejects.toThrow("PNG");
	});

	it("aborts a pending HTTP body instead of leaving a media request running", async () => {
		let started: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "image/png" });
			response.write(png().subarray(0, 20));
			started?.();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP test server");
		const controller = new AbortController();
		const result = loadFormImage(`http://127.0.0.1:${address.port}/slow`, "/tmp", controller.signal);
		await ready;
		controller.abort();
		await expect(result).rejects.toThrow();
	});
});
