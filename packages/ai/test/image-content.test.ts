import { describe, expect, it } from "vitest";
import type { ImageContent } from "../src/types.ts";
import { imageToUrl, requireImageData } from "../src/utils/image-content.ts";

describe("image-content helpers (earendil-works/pi#6151)", () => {
	describe("imageToUrl", () => {
		it("returns a direct url as-is", () => {
			const image: ImageContent = { type: "image", url: "https://example.com/a.png" };
			expect(imageToUrl(image)).toBe("https://example.com/a.png");
		});

		it("wraps base64 data in a data URI", () => {
			const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };
			expect(imageToUrl(image)).toBe("data:image/png;base64,ZmFrZQ==");
		});

		it("prefers url when both url and data are set", () => {
			const image: ImageContent = {
				type: "image",
				url: "https://example.com/b.jpg",
				data: "ZmFrZQ==",
				mimeType: "image/png",
			};
			expect(imageToUrl(image)).toBe("https://example.com/b.jpg");
		});
	});

	describe("requireImageData", () => {
		it("returns data and mimeType when present", () => {
			const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/jpeg" };
			expect(requireImageData(image)).toEqual({ data: "ZmFrZQ==", mimeType: "image/jpeg" });
		});

		it("throws for url-only images", () => {
			const image: ImageContent = { type: "image", url: "https://example.com/c.png" };
			expect(() => requireImageData(image)).toThrow(/base64 image data/);
		});

		it("throws when mimeType is missing", () => {
			const image: ImageContent = { type: "image", data: "ZmFrZQ==" };
			expect(() => requireImageData(image)).toThrow(/base64 image data/);
		});
	});
});
