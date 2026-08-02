import { describe, expect, it } from "vitest";
import type { VideosContext, VideosModel } from "../src/types.ts";
import { downloadVideo, generateVideos, queryVideoGeneration } from "../src/videos.ts";

function testModel(input: Partial<VideosModel<"minimax-videos">> = {}): VideosModel<"minimax-videos"> {
	return {
		id: "MiniMax-H3",
		name: "MiniMax-H3",
		api: "minimax-videos",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/v2/video_generation",
		apiVersion: "v2",
		input: ["text", "image", "video", "audio"],
		output: ["video", "audio"],
		resolutions: ["2K"],
		durationSeconds: { min: 4, max: 15, integer: true },
		cost: { outputVideo: 0.13, inputReferenceVideo: 0.02, inputReferenceAudio: 0, additionalReferenceImage: 0.03 },
		...input,
	};
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("MiniMax videos", () => {
	it("creates a v2 video task with content, duration, ratio, and CN regional fields", async () => {
		const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
		const fetch = async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			calls.push({
				url: String(url),
				init: init ?? {},
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			});
			return jsonResponse({ task_id: "task-1", base_resp: { status_code: 0 } });
		};
		const model = testModel({
			provider: "minimax-cn",
			baseUrl: "https://api.minimaxi.com/v2/video_generation",
		});
		const context: VideosContext = {
			prompt: "Generate a short launch clip",
			input: [
				{ type: "image_url", url: "https://example.test/first.png", role: "first_frame" },
				{ type: "audio_url", url: "https://example.test/ref.mp3", role: "reference_audio" },
			],
			resolution: "2K",
			duration: 6,
			ratio: "16:9",
			callbackUrl: "https://example.test/callback",
			aigcWatermark: true,
		};

		const output = await generateVideos(model, context, { apiKey: "test", fetch });

		expect(output).toMatchObject({ stopReason: "stop", taskId: "task-1", responseId: "task-1" });
		expect(calls[0].url).toBe("https://api.minimaxi.com/v2/video_generation");
		expect(calls[0].init.method).toBe("POST");
		expect(calls[0].body).toMatchObject({
			model: "MiniMax-H3",
			resolution: "2K",
			duration: 6,
			ratio: "16:9",
			callback_url: "https://example.test/callback",
			aigc_watermark: true,
		});
		expect(calls[0].body.content).toEqual([
			{ type: "text", text: "Generate a short launch clip" },
			{ type: "image_url", image_url: "https://example.test/first.png", role: "first_frame" },
			{ type: "audio_url", audio_url: "https://example.test/ref.mp3", role: "reference_audio" },
		]);
	});

	it("queries a v2 task and parses completed video URLs", async () => {
		const urls: string[] = [];
		const fetch = async (url: Parameters<typeof globalThis.fetch>[0]) => {
			urls.push(String(url));
			return jsonResponse({
				task: {
					id: "task-2",
					status: "Success",
					content: { url: "https://example.test/video.mp4" },
				},
				base_resp: { status_code: 0 },
			});
		};

		const output = await queryVideoGeneration(testModel(), "task-2", { apiKey: "test", fetch });

		expect(urls[0]).toBe("https://api.minimax.io/v2/query/video_generation/task-2");
		expect(output).toMatchObject({
			stopReason: "stop",
			status: "completed",
			taskId: "task-2",
			output: [{ type: "video", url: "https://example.test/video.mp4" }],
		});
	});

	it("builds v1 image-to-video requests and parses query/download fields", async () => {
		const calls: string[] = [];
		const bodies: Record<string, unknown>[] = [];
		const fetch = async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			calls.push(String(url));
			if (init?.body) bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			if (String(url).includes("/files/retrieve")) {
				return jsonResponse({
					file: { download_url: "https://example.test/file.mp4" },
					base_resp: { status_code: 0 },
				});
			}
			if (String(url).includes("/query/")) {
				return jsonResponse({ status: "Processing", file_id: "file-1", base_resp: { status_code: 0 } });
			}
			return jsonResponse({ task_id: "task-3", base_resp: { status_code: 0 } });
		};
		const model = testModel({
			id: "MiniMax-Hailuo-2.3",
			baseUrl: "https://api.minimax.io/v1/video_generation",
			apiVersion: "v1",
			input: ["text", "image"],
			output: ["video"],
			resolutions: ["768P", "1080P"],
			durationSeconds: { min: 1, max: 10, integer: true },
		});

		const created = await generateVideos(
			model,
			{
				prompt: "Animate this frame",
				firstFrameImage: "https://example.test/frame.png",
				duration: 5,
				resolution: "1080P",
			},
			{ apiKey: "test", fetch },
		);
		const queried = await queryVideoGeneration(model, "task-3", { apiKey: "test", fetch });
		const downloaded = await downloadVideo(model, "file-1", { apiKey: "test", fetch });

		expect(created.taskId).toBe("task-3");
		expect(bodies[0]).toMatchObject({
			model: "MiniMax-Hailuo-2.3",
			prompt: "Animate this frame",
			first_frame_image: "https://example.test/frame.png",
			duration: 5,
			resolution: "1080P",
		});
		expect(calls[1]).toBe("https://api.minimax.io/v1/query/video_generation?task_id=task-3");
		expect(queried).toMatchObject({ stopReason: "in_progress", status: "in_progress", fileId: "file-1" });
		expect(calls[2]).toBe("https://api.minimax.io/v1/files/retrieve?file_id=file-1");
		expect(downloaded.output).toEqual([{ type: "video", url: "https://example.test/file.mp4" }]);
	});
});
