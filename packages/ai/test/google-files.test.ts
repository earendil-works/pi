import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteGoogleFile,
	GOOGLE_FILE_PROCESSING_TIMEOUT_MS,
	type GoogleFile,
	type GoogleFilesContext,
	type GoogleFileUploadInput,
	getGoogleFile,
	uploadGoogleFile,
	waitForGoogleFileActive,
} from "../src/api/google-files.ts";
import type { FetchFunction } from "../src/types.ts";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=abc";

interface RecordedCall {
	url: string;
	method: string;
	headers: Headers;
}

const tempDirs: string[] = [];

function tempFile(bytes: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-google-files-"));
	tempDirs.push(dir);
	const path = join(dir, "clip.mp4");
	writeFileSync(path, bytes);
	return path;
}

function recordingFetch(respond: (call: RecordedCall) => Response): { fetch: FetchFunction; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetch: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		const call: RecordedCall = { url: request.url, method: request.method, headers: request.headers };
		calls.push(call);
		// Drain a streamed body the way a real upload does, so progress callbacks run.
		if (init?.body !== undefined && typeof init.body !== "string") await request.arrayBuffer();
		return respond(call);
	};
	return { fetch, calls };
}

/** The start request is the one that asks for an upload URL; the second call posts the bytes. */
function isStartCall(call: RecordedCall): boolean {
	return call.headers.get("x-goog-upload-command") === "start";
}

/** Google answers the finalize request wrapped in a `file` object, with a `final` status header. */
function uploadedFile(resource: Record<string, unknown>, status = "final"): Response {
	return Response.json({ file: resource }, { status: 200, headers: { "x-goog-upload-status": status } });
}

function fileResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "files/abc",
		uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
		mimeType: "video/mp4",
		sizeBytes: "2048",
		state: "ACTIVE",
		expirationTime: "2030-01-01T00:00:00Z",
		...overrides,
	};
}

function context(fetch: FetchFunction, overrides: Partial<GoogleFilesContext> = {}): GoogleFilesContext {
	return { baseUrl: BASE_URL, apiKey: "test-key", fetch, ...overrides };
}

function uploadInput(path: string): GoogleFileUploadInput {
	return { path, mimeType: "video/mp4", displayName: "clip.mp4" };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uploadGoogleFile", () => {
	it("starts the upload under the un-versioned root and finalizes against the returned URL", async () => {
		const { fetch, calls } = recordingFetch((call) =>
			isStartCall(call)
				? new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } })
				: uploadedFile(fileResource()),
		);

		const file = await uploadGoogleFile(context(fetch), uploadInput(tempFile("video-bytes")));

		expect(calls).toHaveLength(2);
		expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/upload/v1beta/files");
		expect(calls[0]!.method).toBe("POST");
		expect(calls[0]!.headers.get("x-goog-api-key")).toBe("test-key");
		expect(calls[0]!.headers.get("x-goog-upload-header-content-length")).toBe("11");
		expect(calls[0]!.headers.get("x-goog-upload-header-content-type")).toBe("video/mp4");

		expect(calls[1]!.url).toBe(UPLOAD_URL);
		expect(calls[1]!.headers.get("x-goog-upload-command")).toBe("upload, finalize");
		expect(calls[1]!.headers.get("x-goog-upload-offset")).toBe("0");

		expect(file).toEqual({
			name: "files/abc",
			uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
			mimeType: "video/mp4",
			sizeBytes: 2048,
			state: "ACTIVE",
			expiresAt: Date.parse("2030-01-01T00:00:00Z"),
		});
	});

	it("reports how many bytes were sent", async () => {
		const { fetch } = recordingFetch((call) =>
			isStartCall(call)
				? new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } })
				: uploadedFile(fileResource()),
		);
		const sent: number[] = [];

		await uploadGoogleFile(context(fetch), uploadInput(tempFile("0123456789")), {
			onUploadProgress: (uploadedBytes, totalBytes) => {
				expect(totalBytes).toBe(10);
				sent.push(uploadedBytes);
			},
		});

		expect(sent.at(-1)).toBe(10);
	});

	it("fails when the API answers the start request without an upload URL", async () => {
		const { fetch } = recordingFetch(() => new Response("{}", { status: 200 }));

		await expect(uploadGoogleFile(context(fetch), uploadInput(tempFile("x")))).rejects.toThrow(/upload URL/);
	});

	it("reports the status and body of a rejected request", async () => {
		const { fetch } = recordingFetch(() => new Response("quota exceeded", { status: 429 }));

		await expect(uploadGoogleFile(context(fetch), uploadInput(tempFile("x")))).rejects.toThrow(/429.*quota exceeded/);
	});

	it("fails when Google did not finalize the upload", async () => {
		const { fetch } = recordingFetch((call) =>
			isStartCall(call)
				? new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } })
				: uploadedFile(fileResource(), "active"),
		);

		await expect(uploadGoogleFile(context(fetch), uploadInput(tempFile("x")))).rejects.toThrow(
			/did not finish uploading/,
		);
	});

	it("reads the file out of the upload answer's wrapper", async () => {
		const { fetch } = recordingFetch((call) =>
			isStartCall(call)
				? new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } })
				: uploadedFile(fileResource()),
		);

		const file = await uploadGoogleFile(context(fetch), uploadInput(tempFile("video-bytes")));

		expect(file.name).toBe("files/abc");
		expect(file.uri).toBe("https://generativelanguage.googleapis.com/v1beta/files/abc");
	});

	it("rejects a file resource without a name or URI", async () => {
		const { fetch } = recordingFetch((call) =>
			isStartCall(call)
				? new Response("{}", { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } })
				: uploadedFile(fileResource({ uri: undefined })),
		);

		await expect(uploadGoogleFile(context(fetch), uploadInput(tempFile("x")))).rejects.toThrow(
			/without a name or URI/,
		);
	});
});

describe("getGoogleFile", () => {
	it("reads the file under the base URL's version", async () => {
		const { fetch, calls } = recordingFetch(() => Response.json(fileResource({ state: "PROCESSING" })));

		const file = await getGoogleFile(context(fetch), "files/abc");

		expect(calls[0]!.url).toBe(`${BASE_URL}/files/abc`);
		expect(calls[0]!.method).toBe("GET");
		expect(file.state).toBe("PROCESSING");
	});
});

describe("deleteGoogleFile", () => {
	it("deletes by resource name", async () => {
		const { fetch, calls } = recordingFetch(() => new Response("{}", { status: 200 }));

		await deleteGoogleFile(context(fetch), "files/abc");

		expect(calls[0]!.url).toBe(`${BASE_URL}/files/abc`);
		expect(calls[0]!.method).toBe("DELETE");
	});
});

describe("waitForGoogleFileActive", () => {
	const processing: GoogleFile = {
		name: "files/abc",
		uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
		mimeType: "video/mp4",
		state: "PROCESSING",
	};

	it("polls until the file is active", async () => {
		let reads = 0;
		const { fetch } = recordingFetch(() => {
			reads++;
			return Response.json(fileResource({ state: reads < 2 ? "PROCESSING" : "ACTIVE" }));
		});
		const polls: number[] = [];

		const file = await waitForGoogleFileActive(context(fetch), processing, {
			onProcessing: (elapsedMs) => polls.push(elapsedMs),
		});

		expect(file.state).toBe("ACTIVE");
		expect(reads).toBe(2);
		expect(polls).toHaveLength(2);
	});

	it("returns at once for a file that is already active", async () => {
		const { fetch, calls } = recordingFetch(() => Response.json(fileResource()));

		const file = await waitForGoogleFileActive(context(fetch), { ...processing, state: "ACTIVE" });

		expect(file.state).toBe("ACTIVE");
		expect(calls).toHaveLength(0);
	});

	it("fails when processing fails", async () => {
		const { fetch } = recordingFetch(() => Response.json(fileResource({ state: "FAILED" })));

		await expect(waitForGoogleFileActive(context(fetch), processing)).rejects.toThrow(/could not process/);
	});

	it("gives up after the processing timeout", async () => {
		const { fetch } = recordingFetch(() => Response.json(fileResource({ state: "PROCESSING" })));

		await expect(waitForGoogleFileActive(context(fetch, { processingTimeoutMs: 30 }), processing)).rejects.toThrow(
			/still processing/,
		);
	});

	it("defaults the timeout to five minutes", () => {
		expect(GOOGLE_FILE_PROCESSING_TIMEOUT_MS).toBe(5 * 60 * 1000);
	});
});
