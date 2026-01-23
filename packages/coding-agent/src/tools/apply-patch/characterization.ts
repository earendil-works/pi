import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ApplyPatchRunOptions, ApplyPatchRunResult } from "./runner.js";
import { runApplyPatchBinary } from "./runner.js";

const SANDBOX_LABEL = "<sandbox>";

type ApplyPatchRunner = (options: ApplyPatchRunOptions) => Promise<ApplyPatchRunResult>;

function buildPatch(): string {
	return [
		"*** Begin Patch",
		"*** Add File: added.txt",
		"+alpha",
		"+beta",
		"*** Update File: alpha.txt",
		"@@",
		" one",
		"-two",
		"+two-updated",
		" three",
		"*** Update File: move-me.txt",
		"*** Move to: moved/renamed.txt",
		"@@",
		" move-one",
		"-move-two",
		"+move-two-updated",
		"*** Delete File: delete-me.txt",
		"*** End Patch",
	].join("\n");
}

function extractOperations(patch: string): string[] {
	const operations: string[] = [];
	let currentUpdate: string | null = null;
	for (const line of patch.split("\n")) {
		if (line.startsWith("*** Add File: ")) {
			operations.push(`add ${line.slice("*** Add File: ".length)}`);
			currentUpdate = null;
			continue;
		}
		if (line.startsWith("*** Update File: ")) {
			currentUpdate = line.slice("*** Update File: ".length);
			operations.push(`update ${currentUpdate}`);
			continue;
		}
		if (line.startsWith("*** Move to: ")) {
			const destination = line.slice("*** Move to: ".length);
			if (currentUpdate) {
				operations.push(`move ${currentUpdate} -> ${destination}`);
			} else {
				operations.push(`move <unknown> -> ${destination}`);
			}
			continue;
		}
		if (line.startsWith("*** Delete File: ")) {
			operations.push(`delete ${line.slice("*** Delete File: ".length)}`);
			currentUpdate = null;
		}
	}
	return operations;
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

async function runApplyPatchCharacterizationWithRunner(runner: ApplyPatchRunner): Promise<string> {
	const sandbox = await mkdtemp(join(tmpdir(), "apply-patch-golden-"));
	const initialFiles = [
		{ path: "alpha.txt", contents: "one\ntwo\nthree\n" },
		{ path: "move-me.txt", contents: "move-one\nmove-two\n" },
		{ path: "delete-me.txt", contents: "delete-me\n" },
	];
	const finalFiles = ["alpha.txt", "added.txt", "moved/renamed.txt", "move-me.txt", "delete-me.txt"];

	try {
		for (const file of initialFiles) {
			const fullPath = join(sandbox, file.path);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, file.contents, "utf8");
		}

		const patch = buildPatch();
		const operations = extractOperations(patch);

		const outputLines: string[] = [];
		outputLines.push("apply_patch characterization");
		outputLines.push(`sandbox=${SANDBOX_LABEL}`);
		outputLines.push("operations:");
		for (const op of operations) {
			outputLines.push(`- ${op}`);
		}
		outputLines.push("patch:");
		outputLines.push("<<<");
		outputLines.push(patch);
		outputLines.push(">>>");
		outputLines.push("initial_state:");
		outputLines.push(
			...(await formatState(
				sandbox,
				initialFiles.map((file) => file.path),
			)),
		);

		const result = await runner({ patch, cwd: sandbox });

		outputLines.push("run:");
		outputLines.push(`exit_code=${result.exitCode ?? "null"}`);
		outputLines.push("stdout:");
		outputLines.push(formatStream(result.stdout));
		outputLines.push("stderr:");
		outputLines.push(formatStream(result.stderr));
		outputLines.push("final_state:");
		outputLines.push(...(await formatState(sandbox, finalFiles)));

		return `${outputLines.join("\n")}\n`;
	} finally {
		await rm(sandbox, { recursive: true, force: true });
	}
}

export async function runApplyPatchCharacterization(): Promise<string> {
	return runApplyPatchCharacterizationWithRunner(runApplyPatchBinary);
}

export { runApplyPatchCharacterizationWithRunner };
