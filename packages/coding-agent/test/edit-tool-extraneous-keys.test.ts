import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "../../ai/src/utils/validation.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-edit-extraneous-keys-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

// The model should not emit extra keys, but weaker/smaller models intermittently append a
// near-duplicate filler key after a long newText value (e.g. { newText_strip: "" }) as a
// structural-completion artifact. These tests assert the schema tolerates that artifact and
// that only oldText/newText ever reach the edit logic.
describe("edit tool schema tolerates extraneous keys", () => {
	function validate(args: unknown): unknown {
		const tool = createEditTool(process.cwd());
		return validateToolArguments(tool, {
			type: "toolCall",
			id: "call-1",
			name: "edit",
			arguments: args as Record<string, any>,
		});
	}

	it("accepts an edits[] item with an extra empty-string key", () => {
		expect(() =>
			validate({
				path: "file.txt",
				edits: [{ oldText: "a", newText: "b", newText_strip: "" }],
			}),
		).not.toThrow();
	});

	it("accepts an edits[] item with an extra non-empty-string key", () => {
		expect(() =>
			validate({
				path: "file.txt",
				edits: [{ oldText: "a", newText: "b", newText_x: "garbage" }],
			}),
		).not.toThrow();
	});

	it("still accepts a clean edit", () => {
		expect(() =>
			validate({
				path: "file.txt",
				edits: [{ oldText: "a", newText: "b" }],
			}),
		).not.toThrow();
	});

	it("still rejects an edit missing newText", () => {
		expect(() =>
			validate({
				path: "file.txt",
				edits: [{ oldText: "a" }],
			}),
		).toThrow(/Validation failed/);
	});

	it("still rejects an edit whose oldText is not a string (non-coercible)", () => {
		// An object cannot be coerced to a string by Value.Convert, so it surfaces a clear error.
		expect(() =>
			validate({
				path: "file.txt",
				edits: [{ oldText: { nested: true }, newText: "b" }],
			}),
		).toThrow(/Validation failed/);
	});
});

describe("edit tool ignores extraneous keys at execution", () => {
	it("applies the same change with an extra key as without it", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "noisy.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const input = {
			path: "noisy.txt",
			edits: [{ oldText: "before", newText: "after", newText_strip: "" }],
		};

		const result = await definition.execute("tool-1", input as any, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in noisy.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});

	it("ignores an extra key whose value is a non-empty string", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "noisy2.txt");
		await writeFile(filePath, "before\n", "utf8");

		const definition = createEditToolDefinition(dir);
		const input = {
			path: "noisy2.txt",
			edits: [{ oldText: "before", newText: "after", newText_x: "should be ignored" }],
		};

		const result = await definition.execute("tool-2", input as any, undefined, undefined, {} as ExtensionContext);
		expect(result.content).toEqual([{ type: "text", text: "Successfully replaced 1 block(s) in noisy2.txt." }]);
		expect(await readFile(filePath, "utf8")).toBe("after\n");
	});
});
