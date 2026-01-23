import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ApplyPatchTrace, runApplyPatchEngineWithTrace } from "./engine.js";

const SANDBOX_LABEL = "<sandbox>";

interface ScenarioFile {
	path: string;
	contents: string;
}

interface Scenario {
	name: string;
	initialFiles: ScenarioFile[];
	patch: string;
	finalFiles: string[];
}

function formatStream(stream: string | null): string {
	if (!stream) {
		return "<empty>";
	}
	if (stream.length === 0) {
		return "<empty>";
	}
	const normalized = stream.replace(/\r\n/g, "\n");
	return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function formatTrace(lines: string[]): string[] {
	if (lines.length === 0) {
		return ["<empty>"];
	}
	return lines;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

async function readFileIfExists(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function formatState(root: string, paths: string[]): Promise<string[]> {
	const lines: string[] = [];
	for (const relativePath of paths) {
		const fullPath = join(root, relativePath);
		const contents = await readFileIfExists(fullPath);
		if (contents === null) {
			lines.push(`- ${relativePath}: <missing>`);
		} else {
			lines.push(`- ${relativePath}: ${JSON.stringify(contents)}`);
		}
	}
	return lines;
}

function buildScenarios(): Scenario[] {
	return [
		{
			name: "add_delete",
			initialFiles: [{ path: "delete.txt", contents: "to-delete\n" }],
			patch: [
				"*** Begin Patch",
				"*** Add File: added.txt",
				"+alpha",
				"*** Delete File: delete.txt",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["added.txt", "delete.txt"],
		},
		{
			name: "exact_match",
			initialFiles: [{ path: "exact.txt", contents: "alpha\nbeta\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: exact.txt",
				"@@",
				" alpha",
				"-beta",
				"+beta-updated",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["exact.txt"],
		},
		{
			name: "trim_end_match",
			initialFiles: [{ path: "trim-end.txt", contents: "alpha   \n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: trim-end.txt",
				"@@",
				"-alpha",
				"+alpha-updated",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["trim-end.txt"],
		},
		{
			name: "trim_match",
			initialFiles: [{ path: "trim.txt", contents: "  beta  \n" }],
			patch: ["*** Begin Patch", "*** Update File: trim.txt", "@@", "-beta", "+beta-updated", "*** End Patch"].join(
				"\n",
			),
			finalFiles: ["trim.txt"],
		},
		{
			name: "confusable_match",
			initialFiles: [{ path: "confusable.txt", contents: "const x = “hello”;\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: confusable.txt",
				"@@",
				'-const x = "hello";',
				'+const x = "world";',
				"*** End Patch",
			].join("\n"),
			finalFiles: ["confusable.txt"],
		},
		{
			name: "invisible_char_match",
			initialFiles: [{ path: "invisible.txt", contents: "alpha\u200Bbeta\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: invisible.txt",
				"@@",
				"-alphabeta",
				"+alpha-beta",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["invisible.txt"],
		},
		{
			name: "whitespace_normalized",
			initialFiles: [{ path: "whitespace.txt", contents: "alpha   beta\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: whitespace.txt",
				"@@",
				"-alpha beta",
				"+alpha beta updated",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["whitespace.txt"],
		},
		{
			name: "unescaped_match",
			initialFiles: [{ path: "unescape.txt", contents: "tab\tvalue\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: unescape.txt",
				"@@",
				"-tab\\tvalue",
				"+tab\tupdated",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["unescape.txt"],
		},
		{
			name: "fuzzy_match",
			initialFiles: [{ path: "fuzzy.txt", contents: "const value = 10;\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: fuzzy.txt",
				"@@",
				"-const value = 11;",
				"+const value = 12;",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["fuzzy.txt"],
		},
		{
			name: "context_match",
			initialFiles: [
				{
					path: "context.txt",
					contents: "header\nfunction foo() {\n  const x = 1;\n}\ntail\n",
				},
			],
			patch: [
				"*** Begin Patch",
				"*** Update File: context.txt",
				"@@ function foo() {",
				"-  const x = 1;",
				"+  const x = 2;",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["context.txt"],
		},
		{
			name: "insert_at_eof",
			initialFiles: [{ path: "eof.txt", contents: "alpha\n" }],
			patch: ["*** Begin Patch", "*** Update File: eof.txt", "@@", "+beta", "*** End of File", "*** End Patch"].join(
				"\n",
			),
			finalFiles: ["eof.txt"],
		},
		{
			name: "pattern_trimmed_for_eof",
			initialFiles: [{ path: "trim-eof.txt", contents: "alpha\nbeta\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: trim-eof.txt",
				"@@",
				" alpha",
				" beta",
				" ",
				"+beta-updated",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["trim-eof.txt"],
		},
		{
			name: "missing_lines",
			initialFiles: [{ path: "missing.txt", contents: "alpha\n" }],
			patch: [
				"*** Begin Patch",
				"*** Update File: missing.txt",
				"@@",
				"-beta",
				"+beta-updated",
				"*** End Patch",
			].join("\n"),
			finalFiles: ["missing.txt"],
		},
	];
}

async function runScenario(scenario: Scenario): Promise<string> {
	const sandbox = await mkdtemp(join(tmpdir(), "apply-patch-trace-"));
	const traceLines: string[] = [];
	const trace: ApplyPatchTrace = {
		log: (line) => {
			traceLines.push(line);
		},
	};

	try {
		for (const file of scenario.initialFiles) {
			const fullPath = join(sandbox, file.path);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, file.contents, "utf8");
		}

		const outputLines: string[] = [];
		outputLines.push(`scenario=${scenario.name}`);
		outputLines.push(`sandbox=${SANDBOX_LABEL}`);
		outputLines.push("patch:");
		outputLines.push("<<<");
		outputLines.push(scenario.patch);
		outputLines.push(">>>");
		outputLines.push("initial_state:");
		outputLines.push(
			...(await formatState(
				sandbox,
				scenario.initialFiles.map((file) => file.path),
			)),
		);

		const result = await runApplyPatchEngineWithTrace(scenario.patch, sandbox, trace);

		outputLines.push("trace:");
		outputLines.push("<<<");
		outputLines.push(...formatTrace(traceLines));
		outputLines.push(">>>");
		outputLines.push("run:");
		outputLines.push(`exit_code=${result.exitCode}`);
		outputLines.push("stdout:");
		outputLines.push(formatStream(result.stdout));
		outputLines.push("stderr:");
		outputLines.push(formatStream(result.stderr));
		outputLines.push("final_state:");
		outputLines.push(...(await formatState(sandbox, scenario.finalFiles)));

		return `${outputLines.join("\n")}\n`;
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

export async function runApplyPatchMatchingCharacterization(): Promise<string> {
	const outputLines: string[] = [];
	outputLines.push("apply_patch matching characterization");

	for (const scenario of buildScenarios()) {
		outputLines.push("");
		outputLines.push(...(await runScenario(scenario)).trimEnd().split("\n"));
	}

	return `${outputLines.join("\n")}\n`;
}
