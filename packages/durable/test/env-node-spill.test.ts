import type * as Fs from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { NodeExecutionEnv } from "../src/env/node.ts";

// Longer than the shell's post-exit stdio grace period plus the descendant's delayed write.
const SPILL_WRITE_DELAY_MS = 600;
const spill = vi.hoisted(() => ({ rejectedWrites: 0 }));

// Make the spill stream deterministically slow and immediately backpressured.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		createWriteStream: (path: Fs.PathLike, options?: Parameters<typeof Fs.createWriteStream>[1]) => {
			const stream = actual.createWriteStream(
				path,
				typeof options === "object" ? { ...options, highWaterMark: 1 } : { highWaterMark: 1 },
			);
			const writeChunk = stream._write.bind(stream);
			stream._write = (chunk, encoding, callback) => {
				setTimeout(() => writeChunk(chunk, encoding, callback), SPILL_WRITE_DELAY_MS);
			};
			const writeChunks = stream._writev?.bind(stream);
			if (writeChunks !== undefined) {
				stream._writev = (chunks, callback) => {
					setTimeout(() => writeChunks(chunks, callback), SPILL_WRITE_DELAY_MS);
				};
			}
			const write = stream.write.bind(stream);
			stream.write = ((...args: Parameters<Fs.WriteStream["write"]>) => {
				const accepted = Reflect.apply(write, stream, args) as boolean;
				if (!accepted) spill.rejectedWrites++;
				return accepted;
			}) as Fs.WriteStream["write"];
			return stream;
		},
	};
});

const tempDirs: string[] = [];

afterEach(() => {
	spill.rejectedWrites = 0;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("NodeExecutionEnv spill backpressure", () => {
	it.skipIf(process.platform === "win32")(
		"keeps inherited stdio open past the exit grace period while a spill write is pending",
		async () => {
			const root = join(tmpdir(), `pi-durable-env-spill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(root, { recursive: true });
			tempDirs.push(root);
			const env = new NodeExecutionEnv({ cwd: root });
			// The shell exits after the first chunk crosses the capture limit and backpressures the spill. A background
			// descendant retains stdout and writes after the post-exit grace period. Without the pending-spill guard,
			// settlement destroys stdout before that descendant output is read.
			const command = "printf '%020d' 0 | tr 0 a; (sleep 0.2; printf '%01000d' 0 | tr 0 b) &";

			const result = getOrThrow(
				await env.exec(
					command,
					{ capture: { limits: { maxBytes: 10, maxLines: 10, retain: "tail" }, spill: true }, onUpdate: () => {} },
					BACKGROUND_CONTEXT,
				),
			);

			expect(spill.rejectedWrites).toBeGreaterThan(0);
			expect(result.truncation.totalBytes).toBe(1020);
			expect(result.spillPath).toBeDefined();
			tempDirs.push(join(result.spillPath!, ".."));
			expect(getOrThrow(await env.readTextFile(result.spillPath!, BACKGROUND_CONTEXT))).toBe(
				`${"a".repeat(20)}${"b".repeat(1000)}`,
			);
		},
		10_000,
	);
});
