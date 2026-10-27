// Its own file, so Photon is not yet initialized: vitest gives each file fresh modules, and Photon loads only once.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createPhotonImages } from "@earendil-works/pi-durable/images";
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { expect, it } from "vitest";

it("createPhotonImages takes a compiled WebAssembly module, as Cloudflare Workers pass it", async () => {
	const path = createRequire(import.meta.url).resolve("@silvia-odwyer/photon/photon_rs_bg.wasm");
	const { WebAssembly } = globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<object> } };
	const module = (await WebAssembly.compile(await readFile(path))) as Parameters<typeof createPhotonImages>[0];
	const images = createPhotonImages(module);
	// A 1x1 GIF; returned as it is only once it decodes, which fails without an initialized Photon.
	const data = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	const prepared = await images.prepare(Buffer.from(data, "base64"), "image/gif", DEFAULT_IMAGE_LIMITS);
	expect(prepared).toEqual({ data, mimeType: "image/gif" });
});
