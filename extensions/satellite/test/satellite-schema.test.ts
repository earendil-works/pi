import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REMOTE_EXEC_INPUT_SCHEMA } from "../schema.ts";

/**
 * Extract enum values from a zod/v3 `ZodEnum` schema using the public
 * `options` getter (which returns the underlying `_def.values` tuple).
 */
function extractEnumFromZodSchema(zodEnumSchema: { options: readonly string[] }): string[] {
	return [...zodEnumSchema.options];
}

const SATELLITE_SERVER_PATH = resolve(import.meta.dirname, "../satellite-server.ts");
const SOURCE = readFileSync(SATELLITE_SERVER_PATH, "utf-8");

/**
 * Build a regex that matches a tool name reference as it appears inside a
 * TypeScript string literal. The description lives inside a double-quoted
 * string and the inner quotes are escaped (`\"…\"`), so we accept either
 * an unescaped `"name"` or an escaped `\"name\"` form.
 */
function toolRef(name: string): RegExp {
	return new RegExp(`\\\\?\\"${name}\\\\?\\"`);
}

/**
 * Extract the description string literal registered on the `remote_exec`
 * tool inside `createMcpServer`. `TOOL_HANDLERS` is an internal const
 * (not exported) and `createMcpServer` is not exported either, so we read
 * the raw source and slice between the unique opening marker and the
 * closing `",` that precedes `inputSchema: REMOTE_EXEC_INPUT_SCHEMA,`.
 */
function extractRemoteExecDescription(): string {
	const startMarker = 'description: "Run file and shell operations on the remote HPC server.';
	const startIdx = SOURCE.indexOf(startMarker);
	if (startIdx === -1) {
		throw new Error(`Could not find description start marker in ${SATELLITE_SERVER_PATH}`);
	}
	const endMarker = '",\n      inputSchema:';
	const endIdx = SOURCE.indexOf(endMarker, startIdx);
	if (endIdx === -1) {
		throw new Error(`Could not find description end marker in ${SATELLITE_SERVER_PATH}`);
	}
	return SOURCE.slice(startIdx + "description: ".length, endIdx + 1);
}

/**
 * Extract the `TOOL_HANDLERS` object literal from the source. The first
 * `};` after the `const TOOL_HANDLERS` declaration is the closing brace —
 * the object literal has no nested `};`.
 */
function extractToolHandlersBlock(): string {
	const startMarker = "const TOOL_HANDLERS";
	const startIdx = SOURCE.indexOf(startMarker);
	if (startIdx === -1) {
		throw new Error(`Could not find TOOL_HANDLERS in ${SATELLITE_SERVER_PATH}`);
	}
	const endMarker = "};";
	const endIdx = SOURCE.indexOf(endMarker, startIdx);
	if (endIdx === -1) {
		throw new Error(`Could not find end of TOOL_HANDLERS in ${SATELLITE_SERVER_PATH}`);
	}
	return SOURCE.slice(startIdx, endIdx + endMarker.length);
}

const DESCRIPTION = extractRemoteExecDescription();
const TOOL_HANDLERS_BLOCK = extractToolHandlersBlock();

describe("REMOTE_EXEC_INPUT_SCHEMA — sub-tool enum", () => {
	it("enum includes only the 5 approved short names (read/write/edit/bash/transfer_file)", () => {
		const enumValues = extractEnumFromZodSchema(REMOTE_EXEC_INPUT_SCHEMA.shape.tool);

		expect(enumValues).toContain("read");
		expect(enumValues).toContain("write");
		expect(enumValues).toContain("edit");
		expect(enumValues).toContain("bash");
		expect(enumValues).toContain("transfer_file");
		expect(enumValues).toHaveLength(5);
	});

	it("enum does NOT include removed sub-tools (list/find/grep)", () => {
		const enumValues = extractEnumFromZodSchema(REMOTE_EXEC_INPUT_SCHEMA.shape.tool);

		expect(enumValues).not.toContain("list");
		expect(enumValues).not.toContain("find");
		expect(enumValues).not.toContain("grep");
	});

	it("enum does NOT include long names (read_file/write_file/edit_file/list_dir/find_files/grep_files)", () => {
		const enumValues = extractEnumFromZodSchema(REMOTE_EXEC_INPUT_SCHEMA.shape.tool);

		expect(enumValues).not.toContain("read_file");
		expect(enumValues).not.toContain("write_file");
		expect(enumValues).not.toContain("edit_file");
		expect(enumValues).not.toContain("list_dir");
		expect(enumValues).not.toContain("find_files");
		expect(enumValues).not.toContain("grep_files");
	});
});

describe("createMcpServer description — sub-tool examples use new short names", () => {
	it("description advertises short tool names (read/write/edit/list/find/grep)", () => {
		expect(DESCRIPTION).toMatch(toolRef("read"));
		expect(DESCRIPTION).toMatch(toolRef("write"));
		expect(DESCRIPTION).toMatch(toolRef("edit"));
		expect(DESCRIPTION).toMatch(toolRef("list"));
		expect(DESCRIPTION).toMatch(toolRef("find"));
		expect(DESCRIPTION).toMatch(toolRef("grep"));
	});

	it("description does NOT advertise long tool names", () => {
		expect(DESCRIPTION).not.toMatch(toolRef("read_file"));
		expect(DESCRIPTION).not.toMatch(toolRef("write_file"));
		expect(DESCRIPTION).not.toMatch(toolRef("edit_file"));
		expect(DESCRIPTION).not.toMatch(toolRef("list_dir"));
		expect(DESCRIPTION).not.toMatch(toolRef("find_files"));
		expect(DESCRIPTION).not.toMatch(toolRef("grep_files"));
	});

	it("description still references bash and transfer_file (unchanged names)", () => {
		expect(DESCRIPTION).toMatch(toolRef("bash"));
		expect(DESCRIPTION).toMatch(toolRef("transfer_file"));
	});
});

describe("TOOL_HANDLERS — keys match new short names", () => {
	it("declares short-name keys (read/write/edit/list/find/grep)", () => {
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  read:\s/m);
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  write:\s/m);
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  edit:\s/m);
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  list:\s/m);
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  find:\s/m);
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  grep:\s/m);
	});

	it("does NOT declare long-name keys (read_file/write_file/edit_file/list_dir/find_files/grep_files)", () => {
		expect(TOOL_HANDLERS_BLOCK).not.toMatch(/^  read_file:\s/m);
		expect(TOOL_HANDLERS_BLOCK).not.toMatch(/^  write_file:\s/m);
		expect(TOOL_HANDLERS_BLOCK).not.toMatch(/^  edit_file:\s/m);
		expect(TOOL_HANDLERS_BLOCK).not.toMatch(/^  list_dir:\s/m);
		expect(TOOL_HANDLERS_BLOCK).not.toMatch(/^  find_files:\s/m);
		expect(TOOL_HANDLERS_BLOCK).not.toMatch(/^  grep_files:\s/m);
	});

	it("keeps bash and transfer_file keys (unchanged names)", () => {
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  bash:\s/m);
		expect(TOOL_HANDLERS_BLOCK).toMatch(/^  transfer_file:\s/m);
	});
});
