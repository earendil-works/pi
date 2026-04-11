import { describe, expect, it } from "vitest";
import { formatSourceTag, prefixAutocompleteDescription, type SourceInfoStyle } from "../src/core/format-source-tag.js";
import type { SourceInfo } from "../src/core/source-info.js";

function makeSourceInfo(overrides: Partial<SourceInfo> = {}): SourceInfo {
	return {
		path: "/some/path",
		source: overrides.source ?? "auto",
		scope: overrides.scope ?? "user",
		origin: overrides.origin ?? "top-level",
	};
}

describe("formatSourceTag", () => {
	describe("none style", () => {
		it("hides source info completely", () => {
			const info = makeSourceInfo({ source: "git:https://github.com/jvortmann/pi-claude-commands" });
			expect(formatSourceTag(info, "none")).toBeUndefined();
		});
	});

	describe("minimal style", () => {
		it("shows only scope prefix for user scope", () => {
			const info = makeSourceInfo({ scope: "user", source: "git:https://github.com/jvortmann/pi-claude-commands" });
			expect(formatSourceTag(info, "minimal")).toBe("u");
		});

		it("shows only scope prefix for project scope", () => {
			const info = makeSourceInfo({ scope: "project", source: "git:https://github.com/jvortmann/pi-claude-commands" });
			expect(formatSourceTag(info, "minimal")).toBe("p");
		});

		it("shows only scope prefix for temporary scope", () => {
			const info = makeSourceInfo({ scope: "temporary", source: "git:https://github.com/jvortmann/pi-claude-commands" });
			expect(formatSourceTag(info, "minimal")).toBe("t");
		});
	});

	describe("git sources", () => {
		const gitSource = "git:https://github.com/jvortmann/pi-claude-commands";

		it("full — shows host and path", () => {
			const info = makeSourceInfo({ source: gitSource });
			expect(formatSourceTag(info, "full")).toBe("u:git:github.com/jvortmann/pi-claude-commands");
		});

		it("short — shows git prefix and path without host", () => {
			const info = makeSourceInfo({ source: gitSource });
			expect(formatSourceTag(info, "short")).toBe("u:git:jvortmann/pi-claude-commands");
		});

		it("tiny — shows path without git prefix or host", () => {
			const info = makeSourceInfo({ source: gitSource });
			expect(formatSourceTag(info, "tiny")).toBe("u:jvortmann/pi-claude-commands");
		});

		it("name-only — shows only repo name", () => {
			const info = makeSourceInfo({ source: gitSource });
			expect(formatSourceTag(info, "name-only")).toBe("u:pi-claude-commands");
		});

		it("preserves ref across all styles", () => {
			const info = makeSourceInfo({ source: "git:https://github.com/jvortmann/pi-claude-commands#main" });
			expect(formatSourceTag(info, "full")).toBe("u:git:github.com/jvortmann/pi-claude-commands@main");
			expect(formatSourceTag(info, "short")).toBe("u:git:jvortmann/pi-claude-commands@main");
			expect(formatSourceTag(info, "tiny")).toBe("u:jvortmann/pi-claude-commands@main");
			expect(formatSourceTag(info, "name-only")).toBe("u:pi-claude-commands@main");
		});
	});

	describe("npm sources", () => {
		const npmSource = "npm:@scope/my-package";

		it("full and short — show full npm: prefix", () => {
			const info = makeSourceInfo({ source: npmSource });
			expect(formatSourceTag(info, "full")).toBe("u:npm:@scope/my-package");
			expect(formatSourceTag(info, "short")).toBe("u:npm:@scope/my-package");
		});

		it("tiny — shows scoped name without npm: prefix", () => {
			const info = makeSourceInfo({ source: npmSource });
			expect(formatSourceTag(info, "tiny")).toBe("u:@scope/my-package");
		});

		it("name-only — shows only package name", () => {
			const info = makeSourceInfo({ source: npmSource });
			expect(formatSourceTag(info, "name-only")).toBe("u:my-package");
		});
	});

	describe("local sources", () => {
		it.each(["auto", "local", "cli"])("%s — shows only scope prefix regardless of style", (source) => {
			const info = makeSourceInfo({ source });
			const styles: SourceInfoStyle[] = ["full", "short", "tiny", "name-only"];
			for (const style of styles) {
				expect(formatSourceTag(info, style)).toBe("u");
			}
		});
	});
});

describe("prefixAutocompleteDescription", () => {
	it("prepends source tag to description", () => {
		const info = makeSourceInfo({ source: "git:https://github.com/jvortmann/pi-claude-commands" });
		expect(prefixAutocompleteDescription("Some command", info, "full")).toBe(
			"[u:git:github.com/jvortmann/pi-claude-commands] Some command",
		);
	});

	it("shows only tag when description is undefined", () => {
		const info = makeSourceInfo({ source: "auto" });
		expect(prefixAutocompleteDescription(undefined, info, "full")).toBe("[u]");
	});

	it("passes description through when sourceInfo is undefined", () => {
		expect(prefixAutocompleteDescription("Some command", undefined, "full")).toBe("Some command");
	});

	it("passes description through when style is none", () => {
		const info = makeSourceInfo({ source: "git:https://github.com/jvortmann/pi-claude-commands" });
		expect(prefixAutocompleteDescription("Some command", info, "none")).toBe("Some command");
	});
});
