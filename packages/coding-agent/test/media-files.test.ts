import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFunction, FileContent, MediaTransferProgress, Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { type MediaTarget, resolveFileContent } from "../src/core/media-files.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc";
const FILE_URI = "https://generativelanguage.googleapis.com/v1beta/files/abc";

let sandbox: string;
let mediaPath: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-media-files-"));
	previousAgentDir = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = join(sandbox, "agent");
	mediaPath = join(sandbox, "clip.mp4");
	writeFileSync(mediaPath, "video-bytes");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
	rmSync(sandbox, { recursive: true, force: true });
});

function gemini(input: MediaTarget["input"] = ["text", "image", "audio", "video"]): MediaTarget {
	return { api: "google-generative-ai", provider: "google", id: "gemini-3.8-flash", baseUrl: BASE_URL, input };
}

function videoBlock(overrides: Partial<FileContent> = {}): FileContent {
	return { type: "file", path: mediaPath, name: "clip.mp4", mimeType: "video/mp4", ...overrides };
}

function messagesWith(file: FileContent): Message[] {
	return [{ role: "user", content: [{ type: "text", text: "what happens here?" }, file], timestamp: Date.now() }];
}

interface FilesApi {
	fetch: FetchFunction;
	uploads(): number;
}

/** Answers the Files API the way Google does: start, finalize, then report an active file. */
function filesApi(options: { state?: "PROCESSING" | "ACTIVE"; expiresInMs?: number } = {}): FilesApi {
	let uploads = 0;
	let reads = 0;
	const expiresInMs = options.expiresInMs ?? 24 * 60 * 60 * 1000;
	const resource = () => ({
		name: "files/abc",
		uri: FILE_URI,
		mimeType: "video/mp4",
		sizeBytes: "11",
		state: reads > 0 || options.state === "ACTIVE" ? "ACTIVE" : "PROCESSING",
		expirationTime: new Date(Date.now() + expiresInMs).toISOString(),
	});
	const fetch: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		if (request.headers.get("x-goog-upload-command") === "start") {
			uploads++;
			return new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } });
		}
		if (request.headers.get("x-goog-upload-command") === "upload, finalize") {
			await request.arrayBuffer();
			// The upload answers the file wrapped in a `file` object; a read answers it directly.
			return Response.json({ file: resource() }, { status: 200, headers: { "x-goog-upload-status": "final" } });
		}
		reads++;
		return Response.json(resource());
	};
	return { fetch, uploads: () => uploads };
}

describe("resolveFileContent", () => {
	it("fills in the provider reference, leaving the transcript's own block untouched", async () => {
		const block = videoBlock();
		const messages = messagesWith(block);
		const api = filesApi({ state: "ACTIVE" });

		const resolved = await resolveFileContent(messages, {
			model: gemini(),
			apiKey: "key",
			fetch: api.fetch,
		});

		const content = resolved[0]?.role === "user" ? resolved[0].content : [];
		expect(Array.isArray(content) && content[1]).toMatchObject({
			type: "file",
			path: mediaPath,
			uri: FILE_URI,
			provider: "google",
			mimeType: "video/mp4",
			sizeBytes: 11,
		});
		expect(block).not.toHaveProperty("uri");
		expect(api.uploads()).toBe(1);
	});

	it("waits for a processing video before handing back a reference", async () => {
		const api = filesApi({ state: "PROCESSING" });

		const resolved = await resolveFileContent(messagesWith(videoBlock()), {
			model: gemini(),
			apiKey: "key",
			fetch: api.fetch,
		});

		const content = resolved[0]?.role === "user" ? resolved[0].content : [];
		expect(Array.isArray(content) && content[1]).toHaveProperty("uri", FILE_URI);
	});

	it("uploads once and reuses the remembered file for the next request", async () => {
		const api = filesApi({ state: "ACTIVE" });
		const options = { model: gemini(), apiKey: "key", fetch: api.fetch };

		await resolveFileContent(messagesWith(videoBlock()), options);
		const second = await resolveFileContent(messagesWith(videoBlock()), options);

		const content = second[0]?.role === "user" ? second[0].content : [];
		expect(Array.isArray(content) && content[1]).toHaveProperty("uri", FILE_URI);
		expect(api.uploads()).toBe(1);
	});

	it("uploads again once Google is about to expire the file", async () => {
		const api = filesApi({ state: "ACTIVE", expiresInMs: 60 * 1000 });
		const options = { model: gemini(), apiKey: "key", fetch: api.fetch };

		await resolveFileContent(messagesWith(videoBlock()), options);
		await resolveFileContent(messagesWith(videoBlock()), options);

		expect(api.uploads()).toBe(2);
	});

	it("reports the upload, the processing wait, and the point the file is ready", async () => {
		const api = filesApi({ state: "PROCESSING" });
		const reported: MediaTransferProgress[] = [];

		await resolveFileContent(messagesWith(videoBlock()), {
			model: gemini(),
			apiKey: "key",
			fetch: api.fetch,
			onProgress: (progress) => reported.push(progress),
		});

		expect(reported[0]).toMatchObject({ stage: "upload", name: "clip.mp4", totalBytes: 11 });
		expect(reported.some((progress) => progress.stage === "processing")).toBe(true);
		expect(reported.at(-1)).toEqual({ stage: "ready", name: "clip.mp4" });
	});

	it("reports nothing for a file that was uploaded earlier", async () => {
		const api = filesApi({ state: "ACTIVE" });
		const options = { model: gemini(), apiKey: "key", fetch: api.fetch };
		await resolveFileContent(messagesWith(videoBlock()), options);
		const reported: MediaTransferProgress[] = [];

		await resolveFileContent(messagesWith(videoBlock()), { ...options, onProgress: (p) => reported.push(p) });

		expect(reported).toEqual([]);
	});

	it("leaves a block alone when it already carries this provider's reference", async () => {
		const api = filesApi({ state: "ACTIVE" });
		const resolvedBlock = videoBlock({ uri: FILE_URI, provider: "google" });

		const resolved = await resolveFileContent(messagesWith(resolvedBlock), {
			model: gemini(),
			apiKey: "key",
			fetch: api.fetch,
		});

		expect(resolved).toHaveLength(1);
		expect(api.uploads()).toBe(0);
	});

	it("returns the same messages for a provider without file references", async () => {
		const messages = messagesWith(videoBlock());
		const api = filesApi({ state: "ACTIVE" });

		const resolved = await resolveFileContent(messages, {
			model: {
				api: "anthropic-messages",
				provider: "anthropic",
				id: "claude",
				baseUrl: BASE_URL,
				input: ["text", "image"],
			},
			apiKey: "key",
			fetch: api.fetch,
		});

		expect(resolved).toBe(messages);
		expect(api.uploads()).toBe(0);
	});

	it("skips media the model does not declare, leaving the downgrade to the adapter", async () => {
		const messages = messagesWith(videoBlock());
		const api = filesApi({ state: "ACTIVE" });

		const resolved = await resolveFileContent(messages, {
			model: gemini(["text", "image"]),
			apiKey: "key",
			fetch: api.fetch,
		});

		expect(resolved).toBe(messages);
		expect(api.uploads()).toBe(0);
	});

	it("fails with the file name when the path is gone", async () => {
		const missing = join(sandbox, "gone.mp4");

		await expect(
			resolveFileContent(messagesWith(videoBlock({ path: missing })), {
				model: gemini(),
				apiKey: "key",
				fetch: filesApi({ state: "ACTIVE" }).fetch,
			}),
		).rejects.toThrow(/Could not read clip\.mp4/);
	});

	it("fails with the file name when the upload is rejected", async () => {
		const fetch: FetchFunction = async () => new Response("quota exceeded", { status: 429 });

		await expect(
			resolveFileContent(messagesWith(videoBlock()), { model: gemini(), apiKey: "key", fetch }),
		).rejects.toThrow(/Could not upload clip\.mp4 to Gemini: .*429/);
	});

	it("does not touch the network or the cache directory without an API key", async () => {
		const messages = messagesWith(videoBlock());

		const resolved = await resolveFileContent(messages, { model: gemini(), fetch: filesApi().fetch });

		expect(resolved).toBe(messages);
		await expect(readFile(join(sandbox, "agent", "media-cache", "google"), "utf8")).rejects.toThrow();
	});
});
