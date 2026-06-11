import { describe, expect, it, beforeEach } from "vitest";
import { setCurrentModel, maybeAnnotateNonVisionImage } from "../tools.ts";

describe("maybeAnnotateNonVisionImage", () => {
	beforeEach(() => {
		setCurrentModel(undefined);
	});

	it("text-only result → no annotation", () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "read", path: "/x.txt" },
			content: [{ type: "text" as const, text: "hello" }],
		};
		expect(maybeAnnotateNonVisionImage(event)).toBeUndefined();
	});

	it("non-satellite tool → no annotation", () => {
		const event = {
			toolName: "other",
			input: { tool: "read", path: "/x" },
			content: [{ type: "image" as const, data: "base64", mimeType: "image/png" }],
		};
		expect(maybeAnnotateNonVisionImage(event)).toBeUndefined();
	});

	it("non-read sub-op → no annotation", () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "bash", command: "ls" },
			content: [{ type: "image" as const, data: "base64", mimeType: "image/png" }],
		};
		expect(maybeAnnotateNonVisionImage(event)).toBeUndefined();
	});

	it("image result + vision-capable model → no annotation", () => {
		setCurrentModel({ input: ["text", "image"] } as any);
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "read", path: "/x.png" },
			content: [{ type: "image" as const, data: "base64", mimeType: "image/png" }],
		};
		expect(maybeAnnotateNonVisionImage(event)).toBeUndefined();
	});

	it("image result + non-vision model → replaces with metadata note (drops base64)", () => {
		setCurrentModel({ input: ["text"] } as any);
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "read", path: "/x.png" },
			content: [
				{ type: "text" as const, text: "Read image file [image/png, 12.3KB]" },
				{ type: "image" as const, data: "base64-encoded-bytes-here", mimeType: "image/png" },
			],
		};
		const result = maybeAnnotateNonVisionImage(event);
		expect(result).toBeDefined();
		expect(result!.content).toHaveLength(1);
		expect(result!.content[0].type).toBe("text");
		expect(result!.content[0].text).toContain("does not support images");
		// The base64 bytes MUST be gone (this is the whole point — don't
		// waste model context on bytes it can't read).
		expect(result!.content[0].text).not.toContain("base64-encoded-bytes");
		// The original metadata text should be preserved.
		expect(result!.content[0].text).toContain("Read image file [image/png, 12.3KB]");
	});

	it("no model set yet (early in session) → no annotation (don't crash)", () => {
		const event = {
			toolName: "satellite_remote_exec",
			input: { tool: "read", path: "/x.png" },
			content: [{ type: "image" as const, data: "x", mimeType: "image/png" }],
		};
		expect(maybeAnnotateNonVisionImage(event)).toBeUndefined();
	});
});
