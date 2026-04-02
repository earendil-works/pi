import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/main.js";

describe("exec CLI surface (red)", () => {
	const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

	afterEach(() => {
		logSpy.mockClear();
		errorSpy.mockClear();
	});

	it("documents mu exec and mu exec --json in top-level help", async () => {
		await main(["--help"]);

		const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

		expect(output).toContain("mu exec");
		expect(output).toContain("mu exec --json");
	});

	it("shows dedicated exec usage when running mu exec --help", async () => {
		await main(["exec", "--help"]);

		const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

		expect(output).toContain("Usage:");
		expect(output).toContain("mu exec [options] <prompt>");
		expect(output).not.toContain("mu [options] [@files...] [messages...]");
	});
});
