import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
	type BashOperations,
	createBashTool,
	createReadTool,
	type ExtensionAPI,
	type ReadOperations,
} from "@earendil-works/pi-coding-agent";

const ALLOWED_TOOLS = new Set(["read", "bash"]);
const configuredContainerName = process.env.PI_ISSUE_ANALYSIS_SANDBOX_CONTAINER;
const configuredPlatform = process.env.PI_ISSUE_ANALYSIS_SANDBOX_PLATFORM;

if (!configuredContainerName || !/^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(configuredContainerName)) {
	throw new Error("PI_ISSUE_ANALYSIS_SANDBOX_CONTAINER is missing or invalid");
}
if (configuredPlatform !== "linux" && configuredPlatform !== "windows") {
	throw new Error("PI_ISSUE_ANALYSIS_SANDBOX_PLATFORM must be linux or windows");
}
const containerName: string = configuredContainerName;
const sandboxPlatform: "linux" | "windows" = configuredPlatform;
const isWindows = sandboxPlatform === "windows";
const guestWorkspace = isWindows ? "C:\\workspace" : "/workspace";
const guestHome = isWindows ? "C:\\workspace\\.pi-home" : "/tmp/pi-home";
const guestTemp = isWindows ? "C:\\workspace\\.pi-tmp" : "/tmp";
const guestNode = isWindows ? "C:\\workspace\\.pi-tools\\node\\node.exe" : "node";

type ContainerExecResult = {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
};

type ContainerExecOptions = {
	cwd?: string;
	input?: string | Buffer;
	onData?: (data: Buffer) => void;
	signal?: AbortSignal;
	timeoutSeconds?: number;
};

function executeInContainer(command: string[], options: ContainerExecOptions = {}): Promise<ContainerExecResult> {
	const args = [
		"exec",
		...(options.input === undefined ? [] : ["-i"]),
		"--workdir",
		options.cwd ?? guestWorkspace,
		"--env",
		"CI=true",
		"--env",
		`HOME=${guestHome}`,
		"--env",
		`TMPDIR=${guestTemp}`,
		"--env",
		`TEMP=${guestTemp}`,
		"--env",
		`TMP=${guestTemp}`,
		"--env",
		"NO_COLOR=1",
		...(isWindows
			? [
					"--env",
					"PATH=C:\\workspace\\.pi-tools\\node;C:\\workspace\\.pi-tools\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
				]
			: []),
		containerName,
		...command,
	];

	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}

		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
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

async function executeChecked(command: string[], options?: ContainerExecOptions): Promise<Buffer> {
	const result = await executeInContainer(command, options);
	if (result.exitCode !== 0) {
		throw new Error(result.stderr.toString("utf8").trim() || `Container command exited with ${result.exitCode}`);
	}
	return result.stdout;
}

function createContainerReadOperations(): ReadOperations {
	return {
		readFile: (path) =>
			executeChecked([
				guestNode,
				"-e",
				"const fs=require('node:fs');process.stdout.write(fs.readFileSync(process.argv[1]));",
				path,
			]),
		access: async (path) => {
			await executeChecked([
				guestNode,
				"-e",
				"require('node:fs').accessSync(process.argv[1],require('node:fs').constants.R_OK);",
				path,
			]);
		},
	};
}

function createContainerBashOperations(): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const shellCommand = isWindows
				? [
						"powershell.exe",
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-ExecutionPolicy",
						"Bypass",
						"-Command",
						command,
					]
				: ["/bin/bash", "-lc", command];
			const result = await executeInContainer(shellCommand, {
				cwd,
				onData,
				signal,
				timeoutSeconds: timeout,
			});
			return { exitCode: result.exitCode };
		},
	};
}

export default function (pi: ExtensionAPI) {
	const readTool = createReadTool(guestWorkspace, {
		operations: createContainerReadOperations(),
		resolvePath: (filePath, cwd) => resolve(cwd, filePath),
	});
	const bashTool = createBashTool(guestWorkspace, {
		operations: createContainerBashOperations(),
		exposeSessionEnvironment: false,
	});

	pi.registerTool(readTool);
	pi.registerTool(bashTool);

	pi.on("session_start", async () => {
		const running = await executeChecked([
			guestNode,
			"-e",
			"const fs=require('node:fs');if(fs.existsSync(process.argv[1]))process.stdout.write('running');",
			guestWorkspace,
		]);
		if (running.toString("utf8") !== "running") {
			throw new Error("Issue-analysis Docker sandbox is not ready");
		}
		pi.setActiveTools(["read", "bash"]);
	});

	pi.on("tool_call", (event) => {
		if (!ALLOWED_TOOLS.has(event.toolName)) {
			return { block: true, reason: `Tool ${event.toolName} is not available in issue-analysis CI` };
		}
	});

	pi.on("before_agent_start", (event, ctx) => {
		const hostLine = `Current working directory: ${ctx.cwd}`;
		const shellNote = isWindows ? "; bash tool commands run in Windows PowerShell" : "";
		const guestLine = `Current working directory: ${guestWorkspace} (isolated ${sandboxPlatform} Docker workspace${shellNote})`;
		return {
			systemPrompt: event.systemPrompt.includes(hostLine)
				? event.systemPrompt.replace(hostLine, guestLine)
				: `${event.systemPrompt}\n\n${guestLine}`,
		};
	});
}
