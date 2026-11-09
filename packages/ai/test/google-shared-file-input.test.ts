import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { FileContent, Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const CLIP_URI = "https://generativelanguage.googleapis.com/v1beta/files/abc";

function makeModel(input: Model<"google-generative-ai">["input"]): Model<"google-generative-ai"> {
	return {
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	};
}

function contextWith(file: FileContent): TranscriptContext {
	return normalizeContext({
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "what happens in this clip?" }, file],
				timestamp: Date.now(),
			},
		],
	});
}

function resolvedVideo(overrides: Partial<FileContent> = {}): FileContent {
	return {
		type: "file",
		path: "/tmp/clip.mp4",
		name: "clip.mp4",
		mimeType: "video/mp4",
		uri: CLIP_URI,
		provider: "google",
		...overrides,
	};
}

describe("convertMessages file content", () => {
	it("references an uploaded video by URI", () => {
		const contents = convertMessages(makeModel(["text", "image", "audio", "video"]), contextWith(resolvedVideo()));

		expect(contents[0]?.parts?.[1]).toEqual({ fileData: { fileUri: CLIP_URI, mimeType: "video/mp4" } });
	});

	it("references an uploaded audio file by URI", () => {
		const audio = resolvedVideo({ name: "memo.mp3", mimeType: "audio/mpeg", uri: `${CLIP_URI}-audio` });
		const contents = convertMessages(makeModel(["text", "image", "audio", "video"]), contextWith(audio));

		expect(contents[0]?.parts?.[1]).toEqual({ fileData: { fileUri: `${CLIP_URI}-audio`, mimeType: "audio/mpeg" } });
	});

	it("keeps the order of text and media", () => {
		const contents = convertMessages(makeModel(["text", "video"]), contextWith(resolvedVideo()));

		expect(contents[0]?.parts).toHaveLength(2);
		expect(contents[0]?.parts?.[0]).toEqual({ text: "what happens in this clip?" });
	});

	it("says so when the block was never uploaded", () => {
		const contents = convertMessages(
			makeModel(["text", "image", "audio", "video"]),
			contextWith(resolvedVideo({ uri: undefined, provider: undefined })),
		);

		expect(contents[0]?.parts?.[1]).toEqual({
			text: '(video "clip.mp4" omitted: not uploaded for gemini-3.5-flash)',
		});
	});

	it("refuses a reference issued by another provider", () => {
		const contents = convertMessages(
			makeModel(["text", "image", "audio", "video"]),
			contextWith(resolvedVideo({ provider: "google-vertex" })),
		);

		expect(contents[0]?.parts?.[1]).toHaveProperty("text");
	});

	it("replaces media the model does not accept, keeping the note in place", () => {
		const contents = convertMessages(makeModel(["text", "image"]), contextWith(resolvedVideo()));

		expect(contents[0]?.parts?.[1]).toEqual({
			text: '(video "clip.mp4" omitted: model gemini-3.5-flash does not accept video input)',
		});
	});
});
