import type { Tool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";

export const HANDOFF_FILE_SELECTION_TOOL_NAME = "select_handoff_files";

const handoffFileSelectionSchema = Type.Object({
	xml: Type.String({ description: "XML containing <file> tags with slice syntax" }),
});

export const handoffFileSelectionTool: Tool<typeof handoffFileSelectionSchema> = {
	name: HANDOFF_FILE_SELECTION_TOOL_NAME,
	description: "Select file paths and line slices using XML <file> tags",
	parameters: handoffFileSelectionSchema,
};

function unescapeXmlEntities(raw: string): string {
	let value = raw;

	// Do a couple of passes to handle common double-escaped output like "&amp;lt;file&amp;gt;".
	for (let i = 0; i < 2; i += 1) {
		const next = value
			.replaceAll("&amp;", "&")
			.replaceAll("&lt;", "<")
			.replaceAll("&gt;", ">")
			.replaceAll("&quot;", '"')
			.replaceAll("&apos;", "'")
			.replaceAll("&#39;", "'");
		if (next === value) break;
		value = next;
	}

	return value;
}

function stripWrappingDelimiters(raw: string): string {
	let value = raw.trim();
	const wrappers: Array<[string, string]> = [
		["```", "```"],
		["`", "`"],
		['"', '"'],
		["'", "'"],
	];

	for (;;) {
		let changed = false;
		for (const [start, end] of wrappers) {
			if (value.length >= start.length + end.length && value.startsWith(start) && value.endsWith(end)) {
				value = value.slice(start.length, value.length - end.length).trim();
				changed = true;
			}
		}
		if (!changed) break;
	}

	return value;
}

function normalizeSelections(items: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const item of items) {
		const trimmed = stripWrappingDelimiters(item);
		if (!trimmed) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}

	return result;
}

type XmlParseState = {
	inTag: boolean;
	inFile: boolean;
	tagBuffer: string;
	fileBuffer: string;
	selections: string[];
};

function extractAttribute(tag: string, name: string): string | null {
	const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`, "i");
	const match = tag.match(pattern);
	const rawValue = match ? (match[1] ?? match[2]) : null;
	return rawValue ? rawValue.trim() : null;
}

function parseXmlSelections(raw: string): string[] {
	const state: XmlParseState = {
		inTag: false,
		inFile: false,
		tagBuffer: "",
		fileBuffer: "",
		selections: [],
	};

	const flushFile = () => {
		const trimmed = state.fileBuffer.trim();
		if (trimmed) state.selections.push(trimmed);
		state.fileBuffer = "";
	};

	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (state.inTag) {
			state.tagBuffer += ch;
			if (ch === ">") {
				const tag = state.tagBuffer;
				state.tagBuffer = "";
				state.inTag = false;

				const openFile = /^<file(?:\s[^>]*)?>$/i.test(tag);
				const closeFile = /^<\/file\s*>$/i.test(tag);
				const selfClosing = /^<file(?:\s[^>]*)?\/>$/i.test(tag);

				if (selfClosing) {
					const pathAttr = extractAttribute(tag, "path") ?? extractAttribute(tag, "name");
					if (pathAttr) state.selections.push(pathAttr);
					continue;
				}

				if (openFile) {
					if (state.inFile) flushFile();
					state.inFile = true;
					state.fileBuffer = "";
					continue;
				}

				if (closeFile) {
					if (state.inFile) flushFile();
					state.inFile = false;
					continue;
				}

				if (state.inFile) {
					state.fileBuffer += tag;
				}
			}
		} else if (ch === "<") {
			state.inTag = true;
			state.tagBuffer = "<";
		} else if (state.inFile) {
			state.fileBuffer += ch;
		}
	}

	if (state.inFile) {
		flushFile();
	}

	return normalizeSelections(state.selections);
}

export function parseHandoffFileSelections(raw: string): string[] {
	const trimmed = unescapeXmlEntities(raw).trim();
	if (!trimmed) return [];

	return parseXmlSelections(trimmed);
}
