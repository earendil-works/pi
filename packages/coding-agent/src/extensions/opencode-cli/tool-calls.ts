import { posix, win32 } from "node:path";
import { objectRecord } from "./json.ts";
import type { ParsedToolCall, ToolCallParseResult } from "./types/tool-calls.ts";

/**
 * Map a blocked native OpenCode call onto the equivalent Pi tool, so Pi runs
 * it under its own permissions. Calls whose semantics differ stay untranslated.
 */
export function translateNativeToolCall(
	tool: string,
	input: unknown,
	allowedToolNames: Set<string>,
	projectDirs: string[],
	paths: typeof posix = process.platform === "win32" ? win32 : posix,
): ParsedToolCall | undefined {
	const args = objectRecord(input);
	if (!args) return undefined;
	const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
	const count = (key: string) => (typeof args[key] === "number" && args[key] > 0 ? (args[key] as number) : undefined);
	// OpenCode resolves paths in its temporary project; Pi resolves them in the real one.
	// Platform path rules also cover Windows slash and drive-letter case differences.
	const path = (key: string) => {
		const value = text(key);
		if (value === undefined || !paths.isAbsolute(value)) return value;
		for (const dir of projectDirs) {
			const rel = paths.relative(dir, value);
			if (rel !== ".." && !rel.startsWith(`..${paths.sep}`) && !paths.isAbsolute(rel)) return rel || ".";
		}
		return value;
	};
	const call = (name: string, entries: Record<string, unknown>): ParsedToolCall => ({
		name,
		arguments: Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)),
	});
	const fileKey = text("filePath") !== undefined ? "filePath" : "path";
	let result: ParsedToolCall | undefined;
	switch (tool) {
		case "bash":
		case "shell": {
			// shortcut: absolute temp-project paths inside the command are not rewritten; parse them if models rely on it.
			const timeout = count("timeout");
			if (
				text("command") === undefined ||
				(args.workdir !== undefined && path("workdir") !== ".") ||
				(tool === "shell" &&
					(args.background === true || args.timeout === 0 || (args.cwd !== undefined && path("cwd") !== ".")))
			)
				break;
			result = call("bash", { command: text("command"), timeout: timeout && Math.ceil(timeout / 1000) });
			break;
		}
		case "read":
			if (text(fileKey) !== undefined) {
				result = call("read", { path: path(fileKey), offset: count("offset"), limit: count("limit") });
			}
			break;
		case "write":
			if (text(fileKey) !== undefined && text("content") !== undefined) {
				result = call("write", { path: path(fileKey), content: text("content") });
			}
			break;
		case "edit":
			// Pi edits need one unique, non-empty match: no replaceAll or create-by-edit.
			if (
				text(fileKey) !== undefined &&
				text("oldString") &&
				text("newString") !== undefined &&
				args.replaceAll !== true
			) {
				result = call("edit", {
					path: path(fileKey),
					edits: [{ oldText: text("oldString"), newText: text("newString") }],
				});
			}
			break;
		case "grep":
			if (text("pattern") !== undefined) {
				result = call("grep", { pattern: text("pattern"), path: path("path"), glob: text("include") });
			}
			break;
		case "glob":
			if (text("pattern") !== undefined) result = call("find", { pattern: text("pattern"), path: path("path") });
			break;
	}
	return result && allowedToolNames.has(result.name) ? result : undefined;
}

const MARKER_OPEN = "<pi_tool_call>";

// Detects marker syntax anywhere in the response, not just at the start, so
// prose-then-marker and marker-then-prose responses are treated the same
// way: either both are rejected as malformed tool-call attempts, or neither
// is. A one-sided check let malformed leading prose silently leak raw
// marker text into the visible chat response while malformed trailing prose
// hard-failed the turn.
//
// Requires the opening marker specifically: a response can only be
// *attempting* a tool call if it emits the open tag. A lone closing marker
// (e.g. prose that merely quotes or discusses `</pi_tool_call>`) is not a
// plausible tool-call attempt and must not hard-fail the turn.
export function isToolCallMarkerResponse(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.includes(MARKER_OPEN);
}

type MarkerClose = { index: number; length: number };

// Models occasionally vary whitespace, separators, plurality, or case in the
// closing tag. Keep the opening marker strict, but accept this bounded family
// of unmistakable Pi marker closers.
const MARKER_CLOSE_PATTERN = /^<\s*\/\s*pi[-_]tool[-_]calls?\s*>/i;

// A closing marker inside a JSON string (e.g. tool arguments that happen to
// contain the literal text "</pi_tool_call>") must not be treated as the
// real boundary, so this walks the JSON string-escaping state rather than
// matching the close tag with a plain regex.
function findMarkerClose(text: string, from: number): MarkerClose | undefined {
	let inString = false;
	let escaped = false;
	for (let i = from; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char !== "<") continue;
		const match = text.slice(i).match(MARKER_CLOSE_PATTERN);
		if (match) return { index: i, length: match[0].length };
	}
	return undefined;
}

// Some models emit a complete marker payload but omit only the closing tag.
// Recover that narrow case by locating one complete top-level JSON object or
// array and requiring whitespace-only content afterward. Payload validation
// and the current-turn tool allowlist are still applied by the caller.
function recoverUnclosedMarkerBody(text: string, bodyStart: number): string | undefined {
	let start = bodyStart;
	while (/\s/.test(text[start] ?? "")) start++;
	const first = text[start];
	if (first !== "{" && first !== "[") return undefined;

	const stack: string[] = [first];
	let inString = false;
	let escaped = false;
	for (let i = start + 1; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === "{" || char === "[") {
			stack.push(char);
			continue;
		}
		if (char !== "}" && char !== "]") continue;

		const expected = char === "}" ? "{" : "[";
		if (stack.pop() !== expected) return undefined;
		if (stack.length === 0) {
			const end = i + 1;
			return text.slice(end).trim() ? undefined : text.slice(bodyStart, end);
		}
	}
	return undefined;
}

function normalizeQuotedToolCallResponse(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return text;
	try {
		const decoded: unknown = JSON.parse(trimmed);
		return typeof decoded === "string" && decoded.includes(MARKER_OPEN) ? decoded : text;
	} catch {
		return text;
	}
}

/**
 * Extract <pi_tool_call> marker bodies from the response text.
 * Lenient: markers are extracted anywhere in the text, even with prose
 * before or after them, matching how real models behave. A marker whose
 * payload cannot be recovered (truncated JSON, unclosed with trailing
 * content) is recorded as an invalid span instead of aborting extraction,
 * so valid sibling markers still parse and the unrecoverable text can be
 * stripped from the displayed response (#39).
 */
type MarkerSpan = { start: number; end: number };

type ExtractedMarker = { body: string; start: number; end: number };

type MarkerExtraction = {
	markers: ExtractedMarker[];
	invalidSpans: MarkerSpan[];
};

function toolCallMarkers(text: string): MarkerExtraction | undefined {
	const trimmed = text.trim();
	const markers: ExtractedMarker[] = [];
	const invalidSpans: MarkerSpan[] = [];
	let cursor = 0;
	while (cursor < trimmed.length) {
		const openIndex = trimmed.indexOf(MARKER_OPEN, cursor);
		if (openIndex === -1) break;

		const bodyStart = openIndex + MARKER_OPEN.length;
		const close = findMarkerClose(trimmed, bodyStart);
		if (close) {
			markers.push({
				body: trimmed.slice(bodyStart, close.index),
				start: openIndex,
				end: close.index + close.length,
			});
			cursor = close.index + close.length;
			continue;
		}

		const recovered = recoverUnclosedMarkerBody(trimmed, bodyStart);
		if (recovered !== undefined) {
			const end = bodyStart + recovered.length;
			markers.push({ body: recovered, start: openIndex, end });
			cursor = end;
			continue;
		}

		// Unrecoverable marker: everything up to the next opening marker (or
		// the end of the response) is inside the attempted marker, so strip it.
		const nextOpen = trimmed.indexOf(MARKER_OPEN, bodyStart);
		const spanEnd = nextOpen === -1 ? trimmed.length : nextOpen;
		invalidSpans.push({ start: openIndex, end: spanEnd });
		cursor = spanEnd;
	}
	if (markers.length === 0 && invalidSpans.length === 0) return undefined;
	return { markers, invalidSpans };
}

function stripMarkerSpans(text: string, spans: MarkerSpan[]): string {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let cleaned = "";
	let cursor = 0;
	for (const span of sorted) {
		if (span.start < cursor) continue;
		cleaned += text.slice(cursor, span.start);
		cursor = Math.max(cursor, span.end);
	}
	cleaned += text.slice(cursor);
	return cleaned;
}

// DeepSeek sometimes ignores the markers and writes its native DSML tool-call
// syntax as plain text. Each complete block is rewritten in place as markers,
// so call order and the tool-list check stay those of the marker parser.
const DSML = String.raw`[｜|]+\s*DSML\s*[｜|]+`;
const DSML_TAG = new RegExp(String.raw`<\/?${DSML}`);
const DSML_BLOCK = new RegExp(
	String.raw`^<${DSML}(?:tool|function)_calls>([\s\S]*?)<\/${DSML}(?:tool|function)_calls>`,
);
const DSML_INVOKE = new RegExp(String.raw`<${DSML}invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/${DSML}invoke>`, "g");
const DSML_PARAMETER = new RegExp(
	String.raw`<${DSML}parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?\s*>([\s\S]*?)<\/${DSML}parameter>`,
	"g",
);

function dsmlBlockToMarkers(body: string): string {
	let markers = "";
	for (const [, name, params] of body.matchAll(DSML_INVOKE)) {
		const args: Record<string, unknown> = {};
		for (const [, key, isString, raw] of params.matchAll(DSML_PARAMETER)) {
			if (isString === "true") {
				args[key] = raw;
				continue;
			}
			try {
				args[key] = JSON.parse(raw);
			} catch {
				args[key] = raw;
			}
		}
		markers += `${MARKER_OPEN}${JSON.stringify({ name, arguments: args })}</pi_tool_call>`;
	}
	return markers;
}

// Scans left to right and consumes whichever starts first, a marker or a DSML
// block, so each keeps the other's syntax intact inside its own arguments.
// Returns undefined for a truncated DSML block, which would otherwise end the
// turn silently or let Pi run only the calls before it.
function dsmlToMarkers(text: string): string | undefined {
	let result = "";
	let rest = text;
	for (;;) {
		const dsmlAt = rest.search(DSML_TAG);
		const markerAt = rest.indexOf(MARKER_OPEN);
		if (dsmlAt < 0) return result + rest;
		if (markerAt >= 0 && markerAt < dsmlAt) {
			// The slice starts at the marker, so trimming cannot shift its span.
			const extraction = toolCallMarkers(rest.slice(markerAt));
			const span = [...(extraction?.markers ?? []), ...(extraction?.invalidSpans ?? [])].find((s) => s.start === 0);
			const end = markerAt + (span?.end ?? MARKER_OPEN.length);
			result += rest.slice(0, end);
			rest = rest.slice(end);
			continue;
		}
		const block = DSML_BLOCK.exec(rest.slice(dsmlAt));
		if (!block) return undefined;
		result += rest.slice(0, dsmlAt) + dsmlBlockToMarkers(block[1]);
		rest = rest.slice(dsmlAt + block[0].length);
	}
}

export function parseToolCallResponse(text: string, allowedToolNames?: ReadonlySet<string>): ToolCallParseResult {
	// A turn without tools (e.g. a compaction summary) cannot call any, so tool
	// syntax it quotes is prose.
	if (allowedToolNames?.size === 0) return { ok: true, calls: [] };
	const normalizedText = dsmlToMarkers(normalizeQuotedToolCallResponse(text));
	if (normalizedText === undefined) {
		return { ok: false, rejection: { reason: "incomplete_dsml" } };
	}
	if (!isToolCallMarkerResponse(normalizedText)) return { ok: true, calls: [] };

	const extraction = toolCallMarkers(normalizedText);
	if (!extraction) return { ok: true, calls: [] };

	const parsed: ParsedToolCall[] = [];
	const strippedSpans: MarkerSpan[] = [...extraction.invalidSpans];
	let payloadRejection: { reason: "invalid_payload" } | undefined;

	for (const marker of extraction.markers) {
		const calls = parseToolCallJson(marker.body);
		if (calls.length === 0) {
			// Skip the invalid body but keep any valid sibling calls; if no
			// call survives, surface the original corrective diagnostic.
			payloadRejection ??= { reason: "invalid_payload" };
			strippedSpans.push({ start: marker.start, end: marker.end });
			continue;
		}
		const unavailable = calls.find((call) => allowedToolNames && !allowedToolNames.has(call.name));
		if (unavailable) {
			return {
				ok: false,
				rejection: {
					reason: "unavailable_tool",
					toolName: unavailable.name,
				},
			};
		}
		parsed.push(...calls);
	}

	if (parsed.length === 0 && payloadRejection) {
		return { ok: false, rejection: payloadRejection };
	}

	if (strippedSpans.length === 0) return { ok: true, calls: parsed };
	const cleanedText = stripMarkerSpans(normalizedText.trim(), strippedSpans);
	if (parsed.length === 0 && !cleanedText.trim()) {
		return { ok: false, rejection: { reason: "malformed_markers" } };
	}
	return { ok: true, calls: parsed, cleanedText };
}

export function parseToolCalls(text: string, allowedToolNames?: ReadonlySet<string>): ParsedToolCall[] {
	const result = parseToolCallResponse(text, allowedToolNames);
	return result.ok ? result.calls : [];
}

/**
 * Detects if the model response contains XML-style tool-use markup
 * (e.g., Claude Code's <bash>, <read>, <arg_key>, <arg_value> tags).
 * Returns the detected tool name if found, or undefined if not.
 */
export function detectXmlToolUse(text: string): string | undefined {
	// Match XML-style tool tags that look like tool invocations.
	// These are NOT <pi_tool_call> markers — they are the model's native format.
	// Claude Code uses <bash>, <read>, <edit>, etc. directly, but may also
	// emit <arg_key>/<arg_value> pairs inside those tags.
	const xmlToolPattern =
		/<(bash|read|edit|write|glob|grep|ls|webfetch|websearch|task|todowrite|question|skill|lsp|external_directory|doom_loop|agent|arg_key|arg_value)\b/i;
	const match = text.match(xmlToolPattern);
	return match ? match[1].toLowerCase() : undefined;
}

export function toolCallRejectionMessage(
	result: Extract<ToolCallParseResult, { ok: false }>,
	allowedToolNames: ReadonlySet<string>,
): string {
	switch (result.rejection.reason) {
		case "malformed_markers":
			return 'OpenCode returned malformed Pi tool-call markers. Ensure each marker contains valid JSON with a string "name" and object "arguments".';
		case "invalid_payload":
			return 'OpenCode returned an invalid Pi tool-call payload. Each marker must contain valid JSON with a non-empty string "name" and object "arguments".';
		case "incomplete_dsml":
			return "OpenCode returned an incomplete DeepSeek DSML tool call.";
		case "unavailable_tool": {
			const available = [...allowedToolNames].map((name) => JSON.stringify(name));
			return `OpenCode requested unavailable Pi tool ${JSON.stringify(result.rejection.toolName)}. Use only tools available in the current Pi turn: ${available.length > 0 ? available.join(", ") : "none"}.`;
		}
	}
}

function parseArguments(value: unknown): Record<string, unknown> | undefined {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return undefined;
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	return parsed as Record<string, unknown>;
}

function repairUnescapedJsonStringQuotes(raw: string): string | undefined {
	const trimmed = raw.trim();
	const matchingContainer =
		(trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
	if (!matchingContainer) return undefined;

	let repaired = "";
	let inString = false;
	let escaped = false;
	let changed = false;

	for (let index = 0; index < trimmed.length; index++) {
		const char = trimmed[index];
		if (!inString) {
			repaired += char;
			if (char === '"') inString = true;
			continue;
		}
		if (escaped) {
			repaired += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			repaired += char;
			escaped = true;
			continue;
		}
		if (char !== '"') {
			repaired += char;
			continue;
		}

		let nextIndex = index + 1;
		while (/\s/.test(trimmed[nextIndex] ?? "")) nextIndex++;
		const next = trimmed[nextIndex];
		if (next === undefined || [",", ":", "}", "]"].includes(next)) {
			repaired += char;
			inString = false;
		} else {
			repaired += '\\"';
			changed = true;
		}
	}

	return changed && !inString ? repaired : undefined;
}

function parseToolCallJson(raw: string): ParsedToolCall[] {
	let value: unknown;
	try {
		value = JSON.parse(raw.trim());
	} catch {
		const repaired = repairUnescapedJsonStringQuotes(raw);
		if (!repaired) return [];
		try {
			value = JSON.parse(repaired);
		} catch {
			return [];
		}
	}

	const container = value as { tool_calls?: unknown } | null;
	const candidates = Array.isArray(value)
		? value
		: Array.isArray(container?.tool_calls)
			? container.tool_calls
			: [value];
	if (candidates.length === 0) return [];

	const calls: ParsedToolCall[] = [];
	for (const rawCandidate of candidates) {
		if (typeof rawCandidate !== "object" || rawCandidate === null || Array.isArray(rawCandidate)) {
			return [];
		}
		const candidate = rawCandidate as {
			name?: unknown;
			tool?: unknown;
			arguments?: unknown;
			args?: unknown;
			input?: unknown;
			function?: { name?: unknown; arguments?: unknown };
		};
		const nameValue =
			typeof candidate.name === "string"
				? candidate.name
				: typeof candidate.tool === "string"
					? candidate.tool
					: candidate.function?.name;

		let argumentsValue: unknown;
		if (Object.hasOwn(candidate, "arguments")) {
			argumentsValue = candidate.arguments;
		} else if (Object.hasOwn(candidate, "args")) {
			argumentsValue = candidate.args;
		} else if (Object.hasOwn(candidate, "input")) {
			argumentsValue = candidate.input;
		} else if (
			candidate.function &&
			typeof candidate.function === "object" &&
			Object.hasOwn(candidate.function, "arguments")
		) {
			argumentsValue = candidate.function.arguments;
		} else {
			return [];
		}

		const args = parseArguments(argumentsValue);
		if (typeof nameValue !== "string" || !nameValue.trim() || !args) {
			return [];
		}
		calls.push({ name: nameValue, arguments: args });
	}
	return calls;
}
