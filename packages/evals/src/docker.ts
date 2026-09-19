import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DocumentationVariant, EvalTask } from "./plan.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

export type BuiltImages = Record<DocumentationVariant, { name: string; id: string }>;

type DockerContext = {
	images: BuiltImages;
	artifactDirectory: string;
	authPath: string;
	provider: string;
	model: string;
	runsPerVariant: number;
};

function execute(command: string, args: readonly string[], capture = false): { status: number; stdout: string } {
	const result = spawnSync(command, args, {
		cwd: packageRoot,
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return { status: result.status ?? 1, stdout: capture ? result.stdout : "" };
}

function requireSuccess(command: string, args: readonly string[]): void {
	const { status } = execute(command, args);
	if (status !== 0) throw new Error(`${command} exited with status ${status}.`);
}

export function buildImages(): BuiltImages {
	const prefix = `pi-evals-${createHash("sha256").update(repositoryRoot).digest("hex").slice(0, 12)}`;
	const images = {
		without_docs: { name: `${prefix}-without-docs:local`, id: "" },
		with_docs: { name: `${prefix}-with-docs:local`, id: "" },
	} satisfies BuiltImages;
	for (const variant of ["without_docs", "with_docs"] as const) {
		requireSuccess("docker", [
			"build",
			"--target",
			variant,
			"--tag",
			images[variant].name,
			"--file",
			join(packageRoot, "docker", "Dockerfile"),
			repositoryRoot,
		]);
		const inspected = execute("docker", ["image", "inspect", "--format", "{{.Id}}", images[variant].name], true);
		if (inspected.status !== 0 || !inspected.stdout.trim())
			throw new Error(`Cannot inspect ${images[variant].name}.`);
		images[variant].id = inspected.stdout.trim();
	}
	return images;
}

function environment(name: string, value: string): string[] {
	return ["--env", `${name}=${value}`];
}

export function requireEvalAuthFile(provider: string): string {
	const path = join(
		process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent"),
		"auth.json",
	);
	if (!existsSync(path) || !statSync(path).isFile())
		throw new Error(`Eval authentication file does not exist: ${path}`);
	let credentials: unknown;
	try {
		credentials = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Eval authentication file is invalid: ${path}`, { cause: error });
	}
	if (
		typeof credentials !== "object" ||
		credentials === null ||
		Array.isArray(credentials) ||
		!Object.hasOwn(credentials, provider)
	) {
		throw new Error(`Eval authentication file has no credential for provider ${provider}.`);
	}
	return path;
}

function dockerArgs(
	context: DockerContext,
	variant: DocumentationVariant,
	outputDirectory: string,
	entrypointArgs: readonly string[],
): string[] {
	mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
	const args = [
		"run",
		"--rm",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,exec,mode=1777",
		"--tmpfs",
		"/repo/node_modules/.vite-temp:rw,exec,mode=1777",
		"--mount",
		`type=bind,source=${outputDirectory},target=/artifacts`,
		...environment("PI_EVAL_ARTIFACT_DIR", "/artifacts"),
		...environment("PI_EVAL_RUNS_PER_VARIANT", String(context.runsPerVariant)),
		...environment("PI_EVAL_SANDBOX_UID", "65532"),
		...environment("PI_EVAL_SANDBOX_GID", "65532"),
		...environment("PI_PROVIDER", context.provider),
		...environment("PI_MODEL", context.model),
	];
	if (typeof process.getuid === "function" && typeof process.getgid === "function") {
		args.push(
			...environment("PI_EVAL_ARTIFACT_UID", String(process.getuid())),
			...environment("PI_EVAL_ARTIFACT_GID", String(process.getgid())),
		);
	}
	args.push("--mount", `type=bind,source=${context.authPath},target=/run/pi-eval-secrets/auth.json,readonly`);
	args.push(context.images[variant].name, ...entrypointArgs);
	return args;
}

export function createDockerContext(
	images: BuiltImages,
	artifactDirectory: string,
	authPath: string,
	provider: string,
	model: string,
	runsPerVariant: number,
): DockerContext {
	return { images, artifactDirectory, authPath, provider, model, runsPerVariant };
}

export function discoverCases(
	context: DockerContext,
	variant: DocumentationVariant,
	files: readonly string[],
	vitestArgs: readonly string[],
): string {
	const outputDirectory = join(context.artifactDirectory, "discovery", variant);
	const args = dockerArgs(context, variant, outputDirectory, [
		"--discover",
		"--project",
		"docs",
		...files,
		...vitestArgs,
	]);
	const { status } = execute("docker", args);
	if (status !== 0) throw new Error(`${variant} eval discovery failed.`);
	return join(outputDirectory, "discovered-tests.json");
}

function taskDirectoryName(task: EvalTask): string {
	const identity = JSON.stringify([task.evalSet, task.caseId, task.variant, task.model, task.runNumber]);
	return createHash("sha256").update(identity).digest("hex");
}

export function runTask(context: DockerContext, task: EvalTask): string | undefined {
	const outputDirectory = join(context.artifactDirectory, "tasks", taskDirectoryName(task));
	const testName = `${task.evalSet} ${task.caseId}`;
	const exactName = `^${testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
	const args = dockerArgs(context, task.variant, outputDirectory, [
		"--project",
		"docs",
		task.file,
		"--testNamePattern",
		exactName,
	]);
	execute("docker", args);
	const reportPath = join(outputDirectory, "vitest.json");
	return existsSync(reportPath) ? reportPath : undefined;
}
