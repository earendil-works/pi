import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
	type BashOperations,
	createBashTool,
	createReadTool,
	type ExtensionAPI,
	type ReadOperations,
} from "@earendil-works/pi-coding-agent";

const ALLOWED_TOOLS = new Set(["read", "bash"]);
const configuredWorkspace = process.env.PI_ISSUE_ANALYSIS_MACOS_WORKSPACE;
const configuredNode = process.env.PI_ISSUE_ANALYSIS_MACOS_NODE;

if (!configuredWorkspace || !configuredNode) {
	throw new Error("PI_ISSUE_ANALYSIS_MACOS_WORKSPACE and PI_ISSUE_ANALYSIS_MACOS_NODE are required");
}
const sandboxWorkspace = realpathSync(configuredWorkspace);
const sandboxNode = realpathSync(configuredNode);
const nodeRelativePath = relative(sandboxWorkspace, sandboxNode);
if (!isAbsolute(sandboxWorkspace) || nodeRelativePath.startsWith("..") || isAbsolute(nodeRelativePath)) {
	throw new Error("The macOS sandbox Node executable must be inside the sandbox workspace");
}

const sandboxHome = `${sandboxWorkspace}/.pi-home`;
const sandboxTemp = `${sandboxWorkspace}/.pi-tmp`;
const safePath = `${sandboxWorkspace}/.pi-tools/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

type SandboxExecResult = {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
};

type SandboxExecOptions = {
	input?: string | Buffer;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSeconds?: number;
};

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function executeInSandbox(command: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
	const wrappedCommand = await SandboxManager.wrapWithSandbox(command.map(shellQuote).join(" "));
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}

		const child = spawn(
			"/usr/bin/env",
			[
				"-i",
				"CI=true",
				`HOME=${sandboxHome}`,
				`TMPDIR=${sandboxTemp}`,
				`PATH=${safePath}`,
				"NO_COLOR=1",
				"/bin/bash",
				"--noprofile",
				"--norc",
				"-c",
				wrappedCommand,
			],
			{ cwd: sandboxWorkspace, stdio: ["pipe", "pipe", "pipe"] },
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let failure: Error | undefined;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;

		const terminate = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const onAbort = () => terminate(new Error("aborted"));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutSeconds !== undefined) {
			timeout = setTimeout(
				() => terminate(new Error(`timeout:${options.timeoutSeconds}`)),
				options.timeoutSeconds * 1000,
			);
		}

		child.stdout.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
			options.onData?.(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			options.onData?.(chunk);
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			if (failure) {
				reject(failure);
				return;
			}
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode });
		});
		child.stdin.on("error", () => {});
		child.stdin.end(options.input);
	});
}

async function executeChecked(command: string[]): Promise<Buffer> {
	const result = await executeInSandbox(command);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString("utf8").trim() || `Sandbox command exited with ${result.exitCode}`);
	}
	return result.stdout;
}

function createSandboxReadOperations(): ReadOperations {
	return {
		readFile: (path) =>
			executeChecked([
				sandboxNode,
				"-e",
				"const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]));",
				path,
			]),
		access: async (path) => {
			await executeChecked([
				sandboxNode,
				"-e",
				"require('node:fs').accessSync(process.argv[1],require('node:fs').constants.R_OK);",
				path,
			]);
		},
	};
}

function createSandboxBashOperations(): BashOperations {
	return {
		exec: async (command, _cwd, { onData, signal, timeout }) => {
			const result = await executeInSandbox(["/bin/bash", "--noprofile", "--norc", "-lc", command], {
				onData,
				signal,
				timeoutSeconds: timeout,
			});
			return { exitCode: result.exitCode };
		},
	};
}

export default function (pi: ExtensionAPI) {
	const readTool = createReadTool(sandboxWorkspace, {
		operations: createSandboxReadOperations(),
		resolvePath: (filePath, cwd) => resolve(cwd, filePath),
	});
	const bashTool = createBashTool(sandboxWorkspace, {
		operations: createSandboxBashOperations(),
		exposeSessionEnvironment: false,
	});

	pi.registerTool(readTool);
	pi.registerTool(bashTool);

	pi.on("session_start", async () => {
		await SandboxManager.initialize({
			network: { allowedDomains: [], deniedDomains: [] },
			filesystem: {
				denyRead: [...new Set([homedir(), process.env.RUNNER_TEMP].filter((path): path is string => !!path))],
				allowWrite: [sandboxWorkspace],
				denyWrite: [],
			},
		});
		const running = await executeChecked([
			sandboxNode,
			"-e",
			"const fs=require('node:fs');if(fs.existsSync(process.argv[1]))process.stdout.write('running');",
			sandboxWorkspace,
		]);
		if (running.toString("utf8") !== "running") {
			throw new Error("Issue-analysis macOS sandbox is not ready");
		}
		pi.setActiveTools(["read", "bash"]);
	});

	pi.on("session_shutdown", async () => {
		await SandboxManager.reset();
	});

	pi.on("tool_call", (event) => {
		if (!ALLOWED_TOOLS.has(event.toolName)) {
			return { block: true, reason: `Tool ${event.toolName} is not available in issue-analysis CI` };
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const hostLine = `Current working directory: ${ctx.cwd}`;
		const sandboxLine = `Current working directory: ${sandboxWorkspace} (isolated macOS sandbox-exec workspace)`;
		return {
			systemPrompt: event.systemPrompt.includes(hostLine)
				? event.systemPrompt.replace(hostLine, sandboxLine)
				: `${event.systemPrompt}\n\n${sandboxLine}`,
		};
	});
}
