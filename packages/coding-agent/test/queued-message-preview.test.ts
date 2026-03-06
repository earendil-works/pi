import { describe, expect, it } from "vitest";
import { formatQueuedMessagePreview } from "../src/tui/queued-message-preview.js";

describe("formatQueuedMessagePreview", () => {
	it("keeps queued message previews multiline and indents continuation lines", () => {
		const preview = formatQueuedMessagePreview("first line\nsecond line\nthird line", "next");

		expect(preview).toMatch(/Queued next: first line/);
		expect(preview).toMatch(/\n\s+second line/);
		expect(preview).toMatch(/\n\s+third line/);
	});
});
