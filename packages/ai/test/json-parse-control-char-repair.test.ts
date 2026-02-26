import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.js";

describe("parseStreamingJson control-character repair", () => {
	it("parses JSON tool arguments when command strings contain raw newlines", () => {
		const raw = `{"command":"git commit -m \\"subject\n\nbody\\" -- devdocs/runbooks/deploy-staging.md"}`;

		const parsed = parseStreamingJson<{ command?: string }>(raw);

		expect(parsed).toEqual({
			command: 'git commit -m "subject\n\nbody" -- devdocs/runbooks/deploy-staging.md',
		});
	});

	it("parses JSON tool arguments when command strings contain raw tab characters", () => {
		const raw = `{"command":"printf 'a\tb'"}`;

		const parsed = parseStreamingJson<{ command?: string }>(raw);

		expect(parsed).toEqual({
			command: "printf 'a\tb'",
		});
	});

	it("keeps valid pretty JSON parseable", () => {
		const pretty = '{\n  "command": "echo hi"\n}';

		const parsed = parseStreamingJson<{ command?: string }>(pretty);

		expect(parsed).toEqual({ command: "echo hi" });
	});

	it("does not regress escaped newline handling", () => {
		const escaped = '{"command":"line1\\\\nline2"}';

		const parsed = parseStreamingJson<{ command?: string }>(escaped);

		expect(parsed).toEqual({ command: "line1\\nline2" });
	});
});
