import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	createProvider,
	type FetchFunction,
	type FileContent,
	InMemoryModelsStore,
	type Message,
	type Model,
	type StreamFunction,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const FILE_URI = "https://generativelanguage.googleapis.com/v1beta/files/abc";
const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc";

let sandbox: string;
let mediaPath: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "pi-media-runtime-"));
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

function videoModel(): Model<"google-generative-ai"> {
	return {
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		api: "google-generative-ai",
		provider: "test-google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: false,
		input: ["text", "image", "audio", "video"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	};
}

function filesApi(): { fetch: FetchFunction; uploads: () => number } {
	let uploads = 0;
	const resource = {
		name: "files/abc",
		uri: FILE_URI,
		mimeType: "video/mp4",
		sizeBytes: "11",
		state: "ACTIVE",
	};
	const fetch: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		if (request.headers.get("x-goog-upload-command") === "start") {
			uploads++;
			return new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } });
		}
		if (request.headers.get("x-goog-upload-command") === "upload, finalize") {
			await request.arrayBuffer();
			return Response.json({ file: resource }, { status: 200, headers: { "x-goog-upload-status": "final" } });
		}
		return Response.json(resource);
	};
	return { fetch, uploads: () => uploads };
}

function capturingStream(): { stream: StreamFunction<"google-generative-ai">; contexts: TranscriptContext[] } {
	const contexts: TranscriptContext[] = [];
	const stream: StreamFunction<"google-generative-ai"> = (model, context) => {
		contexts.push(context);
		const eventStream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		eventStream.push({ type: "start", partial: message });
		eventStream.push({ type: "done", reason: "stop", message });
		eventStream.end();
		return eventStream;
	};
	return { stream, contexts };
}

async function createRuntime(stream: StreamFunction<"google-generative-ai">): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(
		createProvider({
			id: "test-google",
			auth: {
				apiKey: { name: "Gemini key", resolve: async () => ({ auth: { apiKey: "test-key" } }) },
			},
			models: [videoModel()],
			api: { "google-generative-ai": { stream, streamSimple: stream } },
		}),
	);
	return runtime;
}

function messagesWithVideo(): Message[] {
	const file: FileContent = { type: "file", path: mediaPath, name: "clip.mp4", mimeType: "video/mp4" };
	return [{ role: "user", content: [{ type: "text", text: "describe this" }, file], timestamp: Date.now() }];
}

describe("ModelRuntime media resolution", () => {
	it("uploads referenced media before handing the transcript to the provider", async () => {
		const capture = capturingStream();
		const runtime = await createRuntime(capture.stream);
		const api = filesApi();

		await runtime.streamSimple(videoModel(), { messages: messagesWithVideo() }, { fetch: api.fetch }).result();

		const sent = capture.contexts[0];
		const content = sent?.messages[0]?.role === "user" ? sent.messages[0].content : [];
		expect(Array.isArray(content) && content[1]).toMatchObject({
			type: "file",
			uri: FILE_URI,
			provider: "test-google",
		});
		expect(api.uploads()).toBe(1);
	});

	it("leaves the caller's messages untouched", async () => {
		const capture = capturingStream();
		const runtime = await createRuntime(capture.stream);
		const messages = messagesWithVideo();

		await runtime.streamSimple(videoModel(), { messages }, { fetch: filesApi().fetch }).result();

		const content = messages[0]?.role === "user" ? messages[0].content : [];
		expect(Array.isArray(content) && content[1]).not.toHaveProperty("uri");
	});
});
