import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

const HEREDOC_STARTS = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);

const CONFUSABLE_MAP: Readonly<Record<string, string>> = {
	"\u2018": "'",
	"\u2019": "'",
	"\u201C": '"',
	"\u201D": '"',
	"\u201A": "'",
	"\u201E": '"',
	"\u00AB": '"',
	"\u00BB": '"',
	"\u2039": "'",
	"\u203A": "'",
	"\u2013": "-",
	"\u2014": "-",
	"\u2010": "-",
	"\u2011": "-",
	"\u2012": "-",
	"\u2015": "-",
	"\u2212": "-",
	"\u00A0": " ",
	"\u2002": " ",
	"\u2003": " ",
	"\u2004": " ",
	"\u2005": " ",
	"\u2006": " ",
	"\u2007": " ",
	"\u2008": " ",
	"\u2009": " ",
	"\u200A": " ",
	"\u202F": " ",
	"\u205F": " ",
	"\u3000": " ",
	"\u2024": ".",
	"\uFF0E": ".",
	"\uFF0C": ",",
};

const INVISIBLE_CHARS: ReadonlySet<string> = new Set([
	"\u200B",
	"\u200C",
	"\u200D",
	"\u200E",
	"\u200F",
	"\uFEFF",
	"\u2060",
]);

const FUZZY_MATCH_THRESHOLD = 0.8;

export interface ApplyPatchRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ApplyPatchTrace {
	log: (line: string) => void;
}

interface ApplyPatchArgs {
	patch: string;
	hunks: Hunk[];
}

interface UpdateFileChunk {
	changeContext: string | null;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

interface AddFileHunk {
	type: "add";
	path: string;
	contents: string;
}

interface DeleteFileHunk {
	type: "delete";
	path: string;
}

interface UpdateFileHunk {
	type: "update";
	path: string;
	movePath: string | null;
	chunks: UpdateFileChunk[];
}

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type Replacement = [startIndex: number, oldLen: number, newLines: string[]];

class ApplyPatchParseError extends Error {
	readonly kind: "invalid_patch" | "invalid_hunk";
	readonly lineNumber?: number;

	constructor(kind: "invalid_patch" | "invalid_hunk", message: string, lineNumber?: number) {
		super(message);
		this.kind = kind;
		this.lineNumber = lineNumber;
	}
}

class ApplyPatchComputeError extends Error {}

class ApplyPatchIoError extends Error {}

interface AffectedPaths {
	added: string[];
	modified: string[];
	deleted: string[];
}

function traceLine(trace: ApplyPatchTrace | undefined, line: string): void {
	if (!trace) {
		return;
	}
	const sanitized = line.replace(/\r?\n/g, "\\n");
	trace.log(sanitized);
}

function normalizeConfusables(input: string): string {
	let result = input;
	for (const char of INVISIBLE_CHARS) {
		result = result.split(char).join("");
	}
	for (const [from, to] of Object.entries(CONFUSABLE_MAP)) {
		result = result.split(from).join(to);
	}
	return result;
}

function normalizeWhitespace(input: string): string {
	return normalizeConfusables(input).replace(/\s+/g, " ").trim();
}

function unescapeString(input: string): string {
	return input.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured) => {
		switch (captured) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "'":
				return "'";
			case '"':
				return '"';
			case "`":
				return "`";
			case "\\":
				return "\\";
			case "\n":
				return "\n";
			case "$":
				return "$";
			default:
				return match;
		}
	});
}

function stripCommonIndent(lines: string[]): string[] {
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
	if (nonEmptyLines.length === 0) {
		return lines;
	}
	const minIndent = Math.min(
		...nonEmptyLines.map((line) => {
			const match = line.match(/^(\s*)/);
			return match ? match[1].length : 0;
		}),
	);
	return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)));
}

async function ensureParentPathSafe(
	baseReal: string,
	parentPath: string,
	createParents: boolean,
	trace?: ApplyPatchTrace,
): Promise<void> {
	const rel = relative(baseReal, parentPath);
	if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
		traceLine(trace, `path_check: target=${parentPath} status=outside_parent`);
		throw new ApplyPatchIoError(`Path escapes working directory: ${parentPath}`);
	}

	const segments = rel.length === 0 ? [] : rel.split(/[/\\]+/);
	let current = baseReal;
	for (const segment of segments) {
		current = join(current, segment);
		try {
			const stat = await lstat(current);
			if (stat.isSymbolicLink()) {
				traceLine(trace, `path_check: target=${current} status=symlink_parent`);
				throw new ApplyPatchIoError(`Refusing to follow symlink parent ${current}`);
			}
			if (!stat.isDirectory()) {
				throw new ApplyPatchIoError(`Expected directory for ${current}`);
			}
		} catch (error) {
			if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
				if (!createParents) {
					throw new ApplyPatchIoError(`Missing parent directory for ${current}`);
				}
				await mkdir(current);
				const created = await lstat(current);
				if (created.isSymbolicLink() || !created.isDirectory()) {
					throw new ApplyPatchIoError(`Invalid directory created at ${current}`);
				}
				continue;
			}
			throw error;
		}
	}
}

async function resolvePathWithinCwd(
	cwd: string,
	target: string,
	createParents: boolean,
	trace?: ApplyPatchTrace,
): Promise<string> {
	if (isAbsolute(target)) {
		if (createParents) {
			await mkdir(dirname(target), { recursive: true });
		}
		traceLine(trace, `path_check: target=${target} status=absolute`);
		return target;
	}
	let baseReal: string;
	try {
		baseReal = await realpath(cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ApplyPatchIoError(`Failed to resolve cwd ${cwd}: ${message}`);
	}
	const resolved = resolve(baseReal, target);
	const rel = relative(baseReal, resolved);
	const isOutside = rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel));
	if (isOutside) {
		traceLine(trace, `path_check: target=${target} status=outside`);
		throw new ApplyPatchIoError(`Path escapes working directory: ${target}`);
	}
	await ensureParentPathSafe(baseReal, dirname(resolved), createParents, trace);
	traceLine(trace, `path_check: target=${target} status=ok`);
	return resolved;
}

async function writeFileExclusive(path: string, contents: string): Promise<void> {
	const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag;
	const handle = await open(path, flags, 0o666);
	try {
		await handle.writeFile(contents, "utf8");
	} finally {
		await handle.close();
	}
}

async function writeFileReplace(path: string, contents: string): Promise<void> {
	const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const flags = constants.O_WRONLY | constants.O_TRUNC | noFollowFlag;
	const handle = await open(path, flags, 0o666);
	try {
		await handle.writeFile(contents, "utf8");
	} finally {
		await handle.close();
	}
}

function levenshteinDistance(a: string, b: string): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	const matrix: number[][] = Array.from({ length: b.length + 1 }, (_, i) =>
		Array.from({ length: a.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
	);

	for (let j = 1; j <= b.length; j += 1) {
		for (let i = 1; i <= a.length; i += 1) {
			const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
			matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + indicator);
		}
	}

	return matrix[b.length][a.length];
}

function lineSimilarity(a: string, b: string): number {
	const normalizedA = normalizeConfusables(a).trim();
	const normalizedB = normalizeConfusables(b).trim();
	const maxLen = Math.max(normalizedA.length, normalizedB.length);
	if (maxLen === 0) {
		return 1;
	}
	const distance = levenshteinDistance(normalizedA, normalizedB);
	return 1 - distance / maxLen;
}

function ensureTrailingNewline(value: string): string {
	if (value.length === 0) {
		return value;
	}
	return value.endsWith("\n") ? value : `${value}\n`;
}

function splitPatchLines(patch: string): string[] {
	const trimmed = patch.trim();
	if (trimmed.length === 0) {
		return [];
	}
	return trimmed.split(/\r?\n/);
}

function checkPatchBoundariesStrict(lines: string[]): void {
	const firstLine = lines.length > 0 ? lines[0].trim() : null;
	const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : null;

	if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) {
		return;
	}
	if (firstLine && firstLine !== BEGIN_PATCH_MARKER) {
		throw new ApplyPatchParseError("invalid_patch", "The first line of the patch must be '*** Begin Patch'");
	}
	throw new ApplyPatchParseError("invalid_patch", "The last line of the patch must be '*** End Patch'");
}

function checkPatchBoundariesLenient(lines: string[], originalError: ApplyPatchParseError): string[] {
	if (lines.length >= 4) {
		const first = lines[0];
		const last = lines[lines.length - 1];
		if (HEREDOC_STARTS.has(first) && last.endsWith("EOF")) {
			const innerLines = lines.slice(1, -1);
			checkPatchBoundariesStrict(innerLines);
			return innerLines;
		}
	}
	throw originalError;
}

function parsePatchText(patch: string, trace?: ApplyPatchTrace): ApplyPatchArgs {
	traceLine(trace, `parse_patch: raw_length=${patch.length}`);
	const lines = splitPatchLines(patch);
	traceLine(trace, `parse_patch: lines=${lines.length}`);
	let patchLines = lines;
	try {
		checkPatchBoundariesStrict(lines);
		traceLine(trace, "parse_patch: boundaries=strict");
	} catch (error) {
		if (error instanceof ApplyPatchParseError) {
			patchLines = checkPatchBoundariesLenient(lines, error);
			traceLine(trace, "parse_patch: boundaries=lenient");
		} else {
			throw error;
		}
	}

	const hunks: Hunk[] = [];
	const lastLineIndex = patchLines.length - 1;
	let remainingLines = patchLines.slice(1, lastLineIndex);
	let lineNumber = 2;
	while (remainingLines.length > 0) {
		const { hunk, linesParsed } = parseOneHunk(remainingLines, lineNumber, trace);
		hunks.push(hunk);
		lineNumber += linesParsed;
		remainingLines = remainingLines.slice(linesParsed);
	}

	traceLine(trace, `parse_patch: hunks=${hunks.length}`);
	return {
		patch: patchLines.join("\n"),
		hunks,
	};
}

function parseOneHunk(
	lines: string[],
	lineNumber: number,
	trace?: ApplyPatchTrace,
): { hunk: Hunk; linesParsed: number } {
	const firstLine = lines[0]?.trim() ?? "";
	if (firstLine.startsWith(ADD_FILE_MARKER)) {
		const path = firstLine.slice(ADD_FILE_MARKER.length);
		let contents = "";
		let parsedLines = 1;
		for (const addLine of lines.slice(1)) {
			if (addLine.startsWith("+")) {
				contents += `${addLine.slice(1)}\n`;
				parsedLines += 1;
			} else {
				break;
			}
		}
		traceLine(trace, `hunk:add path=${path} lines=${parsedLines - 1}`);
		return {
			hunk: { type: "add", path, contents },
			linesParsed: parsedLines,
		};
	}
	if (firstLine.startsWith(DELETE_FILE_MARKER)) {
		const path = firstLine.slice(DELETE_FILE_MARKER.length);
		traceLine(trace, `hunk:delete path=${path}`);
		return { hunk: { type: "delete", path }, linesParsed: 1 };
	}
	if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
		const path = firstLine.slice(UPDATE_FILE_MARKER.length);
		let remainingLines = lines.slice(1);
		let parsedLines = 1;

		let movePath: string | null = null;
		if (remainingLines[0]?.startsWith(MOVE_TO_MARKER)) {
			movePath = remainingLines[0].slice(MOVE_TO_MARKER.length);
			remainingLines = remainingLines.slice(1);
			parsedLines += 1;
		}

		const chunks: UpdateFileChunk[] = [];
		while (remainingLines.length > 0) {
			if (remainingLines[0].trim().length === 0) {
				parsedLines += 1;
				remainingLines = remainingLines.slice(1);
				continue;
			}
			if (remainingLines[0].startsWith("***")) {
				break;
			}

			const { chunk, linesParsed } = parseUpdateFileChunk(
				remainingLines,
				lineNumber + parsedLines,
				chunks.length === 0,
				trace,
			);
			chunks.push(chunk);
			parsedLines += linesParsed;
			remainingLines = remainingLines.slice(linesParsed);
		}

		if (chunks.length === 0) {
			throw new ApplyPatchParseError("invalid_hunk", `Update file hunk for path '${path}' is empty`, lineNumber);
		}

		traceLine(trace, `hunk:update path=${path} move=${movePath ?? "<none>"} chunks=${chunks.length}`);
		return {
			hunk: { type: "update", path, movePath, chunks },
			linesParsed: parsedLines,
		};
	}

	throw new ApplyPatchParseError(
		"invalid_hunk",
		`'${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
		lineNumber,
	);
}

function parseUpdateFileChunk(
	lines: string[],
	lineNumber: number,
	allowMissingContext: boolean,
	trace?: ApplyPatchTrace,
): { chunk: UpdateFileChunk; linesParsed: number } {
	if (lines.length === 0) {
		throw new ApplyPatchParseError("invalid_hunk", "Update hunk does not contain any lines", lineNumber);
	}

	let changeContext: string | null = null;
	let startIndex = 0;
	if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
		changeContext = null;
		startIndex = 1;
	} else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
		changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
		startIndex = 1;
	} else if (!allowMissingContext) {
		throw new ApplyPatchParseError(
			"invalid_hunk",
			`Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
			lineNumber,
		);
	}

	if (startIndex >= lines.length) {
		throw new ApplyPatchParseError("invalid_hunk", "Update hunk does not contain any lines", lineNumber + 1);
	}

	const chunk: UpdateFileChunk = {
		changeContext,
		oldLines: [],
		newLines: [],
		isEndOfFile: false,
	};

	let parsedLines = 0;
	for (const line of lines.slice(startIndex)) {
		if (line === EOF_MARKER) {
			if (parsedLines === 0) {
				throw new ApplyPatchParseError("invalid_hunk", "Update hunk does not contain any lines", lineNumber + 1);
			}
			chunk.isEndOfFile = true;
			parsedLines += 1;
			break;
		}

		if (line.length === 0) {
			chunk.oldLines.push("");
			chunk.newLines.push("");
			parsedLines += 1;
			continue;
		}

		switch (line[0]) {
			case " ":
				chunk.oldLines.push(line.slice(1));
				chunk.newLines.push(line.slice(1));
				parsedLines += 1;
				break;
			case "+":
				chunk.newLines.push(line.slice(1));
				parsedLines += 1;
				break;
			case "-":
				chunk.oldLines.push(line.slice(1));
				parsedLines += 1;
				break;
			default:
				if (parsedLines === 0) {
					throw new ApplyPatchParseError(
						"invalid_hunk",
						`Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
						lineNumber + 1,
					);
				}
				traceLine(
					trace,
					`chunk: context=${changeContext ?? "<none>"} old=${chunk.oldLines.length} new=${chunk.newLines.length} eof=${chunk.isEndOfFile} parsed=${parsedLines + startIndex}`,
				);
				return { chunk, linesParsed: parsedLines + startIndex };
		}
	}

	traceLine(
		trace,
		`chunk: context=${changeContext ?? "<none>"} old=${chunk.oldLines.length} new=${chunk.newLines.length} eof=${chunk.isEndOfFile} parsed=${parsedLines + startIndex}`,
	);
	return { chunk, linesParsed: parsedLines + startIndex };
}

type LineComparator = (line: string, patternLine: string) => boolean;

type LineNormalizer = (line: string) => string;

function arraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let i = 0; i < left.length; i += 1) {
		if (left[i] !== right[i]) {
			return false;
		}
	}
	return true;
}

function findSequenceWithComparator(
	lines: string[],
	pattern: string[],
	searchStart: number,
	lastIndex: number,
	compare: LineComparator,
): number | null {
	for (let i = searchStart; i <= lastIndex; i += 1) {
		let ok = true;
		for (let p = 0; p < pattern.length; p += 1) {
			if (!compare(lines[i + p], pattern[p])) {
				ok = false;
				break;
			}
		}
		if (ok) {
			return i;
		}
	}
	return null;
}

function findSequenceWithNormalizer(
	lines: string[],
	patternNormalized: string[],
	searchStart: number,
	lastIndex: number,
	normalizeLine: LineNormalizer,
): number | null {
	for (let i = searchStart; i <= lastIndex; i += 1) {
		let ok = true;
		for (let p = 0; p < patternNormalized.length; p += 1) {
			if (normalizeLine(lines[i + p]) !== patternNormalized[p]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			return i;
		}
	}
	return null;
}

function findSequenceWithIndentation(
	lines: string[],
	pattern: string[],
	searchStart: number,
	lastIndex: number,
): number | null {
	const normalizedPattern = stripCommonIndent(pattern.map((line) => normalizeConfusables(line)));
	for (let i = searchStart; i <= lastIndex; i += 1) {
		const window = lines.slice(i, i + pattern.length).map((line) => normalizeConfusables(line));
		const normalizedWindow = stripCommonIndent(window);
		if (arraysEqual(normalizedWindow, normalizedPattern)) {
			return i;
		}
	}
	return null;
}

function findSequenceFuzzy(
	lines: string[],
	pattern: string[],
	searchStart: number,
	lastIndex: number,
): { index: number | null; score: number } {
	let bestIndex: number | null = null;
	let bestScore = -1;

	for (let i = searchStart; i <= lastIndex; i += 1) {
		let scoreSum = 0;
		for (let p = 0; p < pattern.length; p += 1) {
			scoreSum += lineSimilarity(lines[i + p], pattern[p]);
		}
		const score = scoreSum / pattern.length;
		if (score > bestScore) {
			bestScore = score;
			bestIndex = i;
		}
	}

	if (bestScore >= FUZZY_MATCH_THRESHOLD) {
		return { index: bestIndex, score: bestScore };
	}
	return { index: null, score: bestScore };
}

function seekSequence(
	lines: string[],
	pattern: string[],
	start: number,
	eof: boolean,
	trace?: ApplyPatchTrace,
): number | null {
	traceLine(trace, `seek:start=${start} eof=${eof} pattern=${JSON.stringify(pattern)}`);
	if (pattern.length === 0) {
		traceLine(trace, `seek:empty -> ${start}`);
		return start;
	}
	if (pattern.length > lines.length) {
		traceLine(trace, "seek:pattern_longer_than_lines");
		return null;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const lastIndex = lines.length - pattern.length;

	const exactIndex = findSequenceWithComparator(
		lines,
		pattern,
		searchStart,
		lastIndex,
		(line, target) => line === target,
	);
	if (exactIndex !== null) {
		traceLine(trace, `seek:exact=${exactIndex}`);
		return exactIndex;
	}
	traceLine(trace, "seek:exact=none");

	const trimEndIndex = findSequenceWithComparator(
		lines,
		pattern,
		searchStart,
		lastIndex,
		(line, target) => line.trimEnd() === target.trimEnd(),
	);
	if (trimEndIndex !== null) {
		traceLine(trace, `seek:trim_end=${trimEndIndex}`);
		return trimEndIndex;
	}
	traceLine(trace, "seek:trim_end=none");

	const trimIndex = findSequenceWithComparator(
		lines,
		pattern,
		searchStart,
		lastIndex,
		(line, target) => line.trim() === target.trim(),
	);
	if (trimIndex !== null) {
		traceLine(trace, `seek:trim=${trimIndex}`);
		return trimIndex;
	}
	traceLine(trace, "seek:trim=none");

	const unescapedPattern = pattern.map((line) => unescapeString(line));
	const unescapedChanged = unescapedPattern.some((line, index) => line !== pattern[index]);
	if (unescapedChanged) {
		const normalizedUnescapedPattern = unescapedPattern.map((line) => normalizeConfusables(line).trim());
		const unescapedIndex = findSequenceWithNormalizer(
			lines,
			normalizedUnescapedPattern,
			searchStart,
			lastIndex,
			(line) => normalizeConfusables(line).trim(),
		);
		if (unescapedIndex !== null) {
			traceLine(trace, `seek:unescaped=${unescapedIndex}`);
			return unescapedIndex;
		}
		traceLine(trace, "seek:unescaped=none");
	} else {
		traceLine(trace, "seek:unescaped=skipped");
	}

	const normalizedPattern = pattern.map((line) => normalizeConfusables(line).trim());
	const normalizedIndex = findSequenceWithNormalizer(lines, normalizedPattern, searchStart, lastIndex, (line) =>
		normalizeConfusables(line).trim(),
	);
	if (normalizedIndex !== null) {
		traceLine(trace, `seek:normalised=${normalizedIndex}`);
		return normalizedIndex;
	}
	traceLine(trace, "seek:normalised=none");

	const whitespacePattern = pattern.map((line) => normalizeWhitespace(line));
	const whitespaceIndex = findSequenceWithNormalizer(
		lines,
		whitespacePattern,
		searchStart,
		lastIndex,
		normalizeWhitespace,
	);
	if (whitespaceIndex !== null) {
		traceLine(trace, `seek:whitespace=${whitespaceIndex}`);
		return whitespaceIndex;
	}
	traceLine(trace, "seek:whitespace=none");

	const indentIndex = findSequenceWithIndentation(lines, pattern, searchStart, lastIndex);
	if (indentIndex !== null) {
		traceLine(trace, `seek:indent=${indentIndex}`);
		return indentIndex;
	}
	traceLine(trace, "seek:indent=none");

	const fuzzyResult = findSequenceFuzzy(lines, pattern, searchStart, lastIndex);
	if (fuzzyResult.index !== null) {
		traceLine(trace, `seek:fuzzy=${fuzzyResult.index} score=${fuzzyResult.score.toFixed(3)}`);
		return fuzzyResult.index;
	}
	traceLine(trace, `seek:fuzzy=none best=${fuzzyResult.score.toFixed(3)}`);

	return null;
}

function computeReplacements(
	originalLines: string[],
	path: string,
	chunks: UpdateFileChunk[],
	trace?: ApplyPatchTrace,
): Replacement[] {
	const replacements: Replacement[] = [];
	let lineIndex = 0;

	traceLine(trace, `compute_replacements: path=${path} chunks=${chunks.length} lines=${originalLines.length}`);

	for (const [chunkIndex, chunk] of chunks.entries()) {
		traceLine(
			trace,
			`compute_chunk: index=${chunkIndex} context=${chunk.changeContext ?? "<none>"} old=${chunk.oldLines.length} new=${chunk.newLines.length} eof=${chunk.isEndOfFile}`,
		);
		if (chunk.changeContext) {
			const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false, trace);
			if (contextIndex === null) {
				throw new ApplyPatchComputeError(`Failed to find context '${chunk.changeContext}' in ${path}`);
			}
			traceLine(trace, `context_found: index=${contextIndex}`);
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			let insertionIndex =
				originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
					? originalLines.length - 1
					: originalLines.length;
			let insertionMode = "eof";
			if (chunk.changeContext && !chunk.isEndOfFile) {
				insertionIndex = Math.min(lineIndex, originalLines.length);
				insertionMode = "context";
			}
			replacements.push([insertionIndex, 0, [...chunk.newLines]]);
			traceLine(trace, `insert_at: index=${insertionIndex} mode=${insertionMode} lines=${chunk.newLines.length}`);
			continue;
		}

		let pattern = chunk.oldLines;
		let newSlice = chunk.newLines;
		let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, trace);

		if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
			pattern = pattern.slice(0, -1);
			if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
				newSlice = newSlice.slice(0, -1);
			}
			traceLine(trace, "pattern_trimmed_for_eof");
			found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, trace);
		}

		if (found !== null) {
			replacements.push([found, pattern.length, [...newSlice]]);
			traceLine(trace, `match_found: index=${found} old_len=${pattern.length} new_len=${newSlice.length}`);
			lineIndex = found + pattern.length;
			continue;
		}

		throw new ApplyPatchComputeError(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
	}

	replacements.sort((left, right) => left[0] - right[0]);
	traceLine(trace, `replacements_sorted: count=${replacements.length}`);
	return replacements;
}

function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
	const updated = [...lines];
	for (let i = replacements.length - 1; i >= 0; i -= 1) {
		const [startIndex, oldLen, newLines] = replacements[i];
		for (let removal = 0; removal < oldLen; removal += 1) {
			if (startIndex < updated.length) {
				updated.splice(startIndex, 1);
			}
		}
		updated.splice(startIndex, 0, ...newLines);
	}
	return updated;
}

async function deriveNewContentsFromChunks(
	fsPath: string,
	displayPath: string,
	chunks: UpdateFileChunk[],
	trace?: ApplyPatchTrace,
): Promise<string> {
	let stat: Awaited<ReturnType<typeof lstat>>;
	try {
		stat = await lstat(fsPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ApplyPatchIoError(`Failed to inspect file to update ${displayPath}: ${message}`);
	}
	if (stat.isSymbolicLink()) {
		traceLine(trace, `symlink_check: path=${displayPath} status=symlink`);
		throw new ApplyPatchIoError(`Refusing to update symlink ${displayPath}`);
	}
	traceLine(trace, `symlink_check: path=${displayPath} status=ok`);

	let originalContents: string;
	try {
		originalContents = await readFile(fsPath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ApplyPatchIoError(`Failed to read file to update ${displayPath}: ${message}`);
	}

	const originalLines = originalContents.split("\n");
	if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
		originalLines.pop();
	}
	traceLine(trace, `update_file: path=${displayPath} lines=${originalLines.length}`);

	const replacements = computeReplacements(originalLines, displayPath, chunks, trace);
	const newLines = applyReplacements(originalLines, replacements);
	if (newLines.length === 0 || newLines[newLines.length - 1] !== "") {
		newLines.push("");
	}
	return newLines.join("\n");
}

async function applyHunksToFiles(hunks: Hunk[], cwd: string, trace?: ApplyPatchTrace): Promise<AffectedPaths> {
	if (hunks.length === 0) {
		traceLine(trace, "apply: no_hunks");
		throw new ApplyPatchIoError("No files were modified.");
	}

	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const hunk of hunks) {
		switch (hunk.type) {
			case "add": {
				traceLine(trace, `apply:add path=${hunk.path}`);
				const fullPath = await resolvePathWithinCwd(cwd, hunk.path, true, trace);
				try {
					await writeFileExclusive(fullPath, hunk.contents);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new ApplyPatchIoError(`Failed to write file ${hunk.path}: ${message}`);
				}
				added.push(hunk.path);
				break;
			}
			case "delete": {
				traceLine(trace, `apply:delete path=${hunk.path}`);
				const fullPath = await resolvePathWithinCwd(cwd, hunk.path, false, trace);
				try {
					await rm(fullPath);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new ApplyPatchIoError(`Failed to delete file ${hunk.path}: ${message}`);
				}
				deleted.push(hunk.path);
				break;
			}
			case "update": {
				traceLine(trace, `apply:update path=${hunk.path} move=${hunk.movePath ?? "<none>"}`);
				const sourcePath = await resolvePathWithinCwd(cwd, hunk.path, false, trace);
				const newContents = await deriveNewContentsFromChunks(sourcePath, hunk.path, hunk.chunks, trace);
				let resolvedMovePath = hunk.movePath ? await resolvePathWithinCwd(cwd, hunk.movePath, true, trace) : null;
				if (resolvedMovePath && resolvedMovePath === sourcePath) {
					traceLine(trace, "move_path_same_as_source");
					resolvedMovePath = null;
				}
				if (resolvedMovePath) {
					const destPath = resolvedMovePath;
					try {
						await writeFileExclusive(destPath, newContents);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						throw new ApplyPatchIoError(`Failed to write file ${hunk.movePath}: ${message}`);
					}
					try {
						await rm(sourcePath);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						throw new ApplyPatchIoError(`Failed to remove original ${hunk.path}: ${message}`);
					}
					const movePath = hunk.movePath ?? hunk.path;
					modified.push(movePath);
				} else {
					try {
						await writeFileReplace(sourcePath, newContents);
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						throw new ApplyPatchIoError(`Failed to write file ${hunk.path}: ${message}`);
					}
					modified.push(hunk.path);
				}
				break;
			}
			default: {
				const exhaustiveCheck: never = hunk;
				void exhaustiveCheck;
				throw new ApplyPatchIoError("Unsupported hunk type");
			}
		}
	}

	return { added, modified, deleted };
}

function printSummary(affected: AffectedPaths): string {
	const lines: string[] = ["Success. Updated the following files:"];
	for (const path of affected.added) {
		lines.push(`A ${path}`);
	}
	for (const path of affected.modified) {
		lines.push(`M ${path}`);
	}
	for (const path of affected.deleted) {
		lines.push(`D ${path}`);
	}
	return `${lines.join("\n")}\n`;
}

async function runApplyPatchEngineInternal(
	patch: string,
	cwd: string,
	trace?: ApplyPatchTrace,
): Promise<ApplyPatchRunResult> {
	traceLine(trace, "run: start");
	try {
		const { hunks } = parsePatchText(patch, trace);
		const affected = await applyHunksToFiles(hunks, cwd, trace);
		const stdout = printSummary(affected);
		traceLine(
			trace,
			`run: success added=${affected.added.length} modified=${affected.modified.length} deleted=${affected.deleted.length}`,
		);
		return {
			exitCode: 0,
			stdout,
			stderr: "",
		};
	} catch (error) {
		if (error instanceof ApplyPatchParseError) {
			const message =
				error.kind === "invalid_patch"
					? `Invalid patch: ${error.message}`
					: `Invalid patch hunk on line ${error.lineNumber ?? 0}: ${error.message}`;
			traceLine(trace, `run: error kind=parse message=${message}`);
			return {
				exitCode: 1,
				stdout: "",
				stderr: ensureTrailingNewline(message),
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		traceLine(trace, `run: error kind=other message=${message}`);
		return {
			exitCode: 1,
			stdout: "",
			stderr: ensureTrailingNewline(message),
		};
	}
}

export async function runApplyPatchEngine(patch: string, cwd: string): Promise<ApplyPatchRunResult> {
	return runApplyPatchEngineInternal(patch, cwd);
}

export async function runApplyPatchEngineWithTrace(
	patch: string,
	cwd: string,
	trace: ApplyPatchTrace,
): Promise<ApplyPatchRunResult> {
	return runApplyPatchEngineInternal(patch, cwd, trace);
}
