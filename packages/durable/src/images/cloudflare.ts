// Wrangler's default `CompiledWasm` rule turns this import into a `WebAssembly.Module`; Workers cannot compile
// WebAssembly from bytes at runtime. Other bundlers do not support it: use `createPhotonImages()` there.
import photonWasm from "@silvia-odwyer/photon/photon_rs_bg.wasm";
import type { ImageProcessor } from "../tools/image-processor.ts";
import { createPhotonImages } from "./index.ts";

/** `createPhotonImages()` for Cloudflare Workers and Durable Objects, built with Wrangler. */
export function createCloudflarePhotonImages(): ImageProcessor {
	return createPhotonImages(photonWasm);
}
