import { describe, expect, it } from "vitest";
import {
	ARG_TOKEN,
	RESERVED_NAMES,
	expandTemplate,
	resolveSlashCommand,
	validateQuickCommand,
} from "./slash-commands";
import type { QuickCommand } from "./api";

describe("expandTemplate", () => {
	it("replaces a single $ARG occurrence", () => {
		expect(expandTemplate("Review this: $ARG", "src/foo.ts")).toBe(
			"Review this: src/foo.ts",
		);
	});

	it("replaces only the first $ARG", () => {
		expect(expandTemplate("first $ARG then $ARG", "x")).toBe("first x then $ARG");
	});

	it("returns prompt unchanged when no $ARG present", () => {
		expect(expandTemplate("no placeholder here", "x")).toBe("no placeholder here");
	});

	it("substitutes empty string", () => {
		expect(expandTemplate("nothing: $ARG today", "")).toBe("nothing:  today");
	});

	it("preserves text after the substitution", () => {
		expect(expandTemplate("$ARG end", "value")).toBe("value end");
	});

	it("preserves text before the substitution", () => {
		expect(expandTemplate("begin $ARG", "value")).toBe("begin value");
	});
});

describe("ARG_TOKEN", () => {
	it("is exactly $ARG", () => {
		expect(ARG_TOKEN).toBe("$ARG");
	});
});

describe("RESERVED_NAMES", () => {
	it("contains compact", () => {
		expect(RESERVED_NAMES.has("compact")).toBe(true);
	});

	it("does not contain arbitrary names", () => {
		expect(RESERVED_NAMES.has("review")).toBe(false);
		expect(RESERVED_NAMES.has("commit")).toBe(false);
	});
});

describe("resolveSlashCommand", () => {
	const cmds: QuickCommand[] = [
		{ name: "review", description: "review code", prompt: "Review this: $ARG" },
		{ name: "commit", description: "commit", prompt: "Make a commit" },
	];

	it("non-slash input → passthrough", () => {
		expect(resolveSlashCommand("hello world", cmds)).toEqual({ kind: "passthrough" });
	});

	it("empty string → passthrough", () => {
		expect(resolveSlashCommand("", cmds)).toEqual({ kind: "passthrough" });
	});

	it("whitespace-only → passthrough", () => {
		expect(resolveSlashCommand("   ", cmds)).toEqual({ kind: "passthrough" });
	});

	it("/compact alone → compact with no customInstructions", () => {
		expect(resolveSlashCommand("/compact", cmds)).toEqual({ kind: "compact" });
	});

	it("/compact with instructions → compact with customInstructions", () => {
		expect(resolveSlashCommand("/compact summarize tightly", cmds)).toEqual({
			kind: "compact",
			customInstructions: "summarize tightly",
		});
	});

	it("/compact trims trailing whitespace", () => {
		expect(resolveSlashCommand("/compact   keep code  ", cmds)).toEqual({
			kind: "compact",
			customInstructions: "keep code",
		});
	});

	it("/review foo.ts → quick command with $ARG substituted", () => {
		expect(resolveSlashCommand("/review src/foo.ts", cmds)).toEqual({
			kind: "quick",
			expanded: "Review this: src/foo.ts",
		});
	});

	it("/commit (no arg, prompt has no $ARG) → quick command expanded as-is", () => {
		expect(resolveSlashCommand("/commit", cmds)).toEqual({
			kind: "quick",
			expanded: "Make a commit",
		});
	});

	it("/review (no arg, prompt has $ARG) → quick command with empty arg", () => {
		expect(resolveSlashCommand("/review", cmds)).toEqual({
			kind: "quick",
			expanded: "Review this: ",
		});
	});

	it("unknown /command → passthrough (let pi process handle extension/template/skill)", () => {
		expect(resolveSlashCommand("/some-extension", cmds)).toEqual({ kind: "passthrough" });
	});

	it("/review   multiple   spaces   → trimmed arg", () => {
		expect(resolveSlashCommand("/review   multiple   spaces", cmds)).toEqual({
			kind: "quick",
			expanded: "Review this: multiple   spaces",
		});
	});

	it("/  (just slash) → passthrough", () => {
		expect(resolveSlashCommand("/", cmds)).toEqual({ kind: "passthrough" });
	});

	it("/compact wins over a same-named user command (none in cmds)", () => {
		const withCompact: QuickCommand[] = [...cmds, { name: "compact", prompt: "user compact" }];
		expect(resolveSlashCommand("/compact", withCompact)).toEqual({ kind: "compact" });
	});

	it("empty quickCommands list → only /compact resolves specially", () => {
		expect(resolveSlashCommand("/anything", [])).toEqual({ kind: "passthrough" });
		expect(resolveSlashCommand("/compact", [])).toEqual({ kind: "compact" });
	});
});

describe("validateQuickCommand", () => {
	const existing: QuickCommand[] = [{ name: "review", prompt: "Review: $ARG" }];

	it("accepts a valid command", () => {
		expect(validateQuickCommand({ name: "commit", prompt: "Commit staged" }, existing)).toBeNull();
	});

	it("rejects empty name", () => {
		expect(validateQuickCommand({ name: "", prompt: "x" }, existing)).toBe("name is required");
	});

	it("rejects name longer than 64 chars", () => {
		expect(validateQuickCommand({ name: "a".repeat(65), prompt: "x" }, existing)).toMatch(
			/at most 64/,
		);
	});

	it("rejects uppercase characters", () => {
		expect(validateQuickCommand({ name: "Commit", prompt: "x" }, existing)).toMatch(/a-z/);
	});

	it("rejects spaces in name", () => {
		expect(validateQuickCommand({ name: "my command", prompt: "x" }, existing)).toMatch(/a-z/);
	});

	it("rejects reserved name 'compact'", () => {
		const err = validateQuickCommand({ name: "compact", prompt: "x" }, existing);
		expect(err).toMatch(/reserved/);
	});

	it("rejects reserved name 'model'", () => {
		expect(validateQuickCommand({ name: "model", prompt: "x" }, existing)).toMatch(/reserved/);
	});

	it("rejects duplicate name", () => {
		expect(validateQuickCommand({ name: "review", prompt: "x" }, existing)).toMatch(/already exists/);
	});

	it("allows editing without false duplicate on same index", () => {
		expect(validateQuickCommand({ name: "review", prompt: "new prompt" }, existing, 0)).toBeNull();
	});

	it("rejects empty prompt", () => {
		expect(validateQuickCommand({ name: "ok", prompt: "" }, existing)).toBe("prompt is required");
	});

	it("rejects prompt longer than 4096 chars", () => {
		expect(validateQuickCommand({ name: "ok", prompt: "x".repeat(4097) }, existing)).toMatch(
			/at most 4096/,
		);
	});

	it("accepts name with hyphens and underscores", () => {
		expect(validateQuickCommand({ name: "my-cmd_v2", prompt: "x" }, existing)).toBeNull();
	});
});