// Durable job catalog and authenticated controls; saved PIDs are never used to stop processes.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	watch,
} from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { Compile } from "typebox/compile";
import { getAgentDir, getInternalInvocation } from "../../config.ts";
import { getShellConfig, getShellEnv, type ShellConfig } from "../../utils/shell.ts";
import { localProof, receivePackets, sendPacket, verifyLocalProof } from "../local-channel.ts";
import {
	type JobInfo,
	JobReplySchema,
	type JobRuntime,
	type JobSpec,
	readJobProgress,
	readJobRuntime,
	readJobSpec,
	writeJobRecord,
} from "./state.ts";

const replyValidator = Compile(JobReplySchema);

export interface StartJobOptions {
	name?: string;
	timeout?: number;
	sessionId?: string;
	shell?: ShellConfig;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

/** Manage private persistent jobs independently of the lifetime of a pi session. */
export class JobManager {
	readonly directory: string;

	constructor(directory = join(getAgentDir(), "jobs")) {
		this.directory = resolve(directory);
	}

	/** Start an independently supervised command and wait until its launch outcome is observable. */
	async start(command: string, cwd: string, options: StartJobOptions = {}): Promise<JobInfo> {
		options.signal?.throwIfAborted();
		const id = randomUUID();
		const directory = this.jobDirectory(id);
		const spec: JobSpec = {
			id,
			name: options.name ?? command.split("\n", 1)[0].slice(0, 128),
			naming: options.name === undefined ? { status: "pending" } : { status: "explicit" },
			command,
			cwd: resolve(cwd),
			createdAt: Date.now(),
			token: randomBytes(32).toString("hex"),
			shell: options.shell ?? getShellConfig(),
			...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
		};
		const invocation = getInternalInvocation("job-worker");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		const staging = join(this.directory, `.launch-${id}`);
		mkdirSync(staging, { mode: 0o700 });
		try {
			writeJobRecord(staging, "spec.json", spec);
			writeJobRecord(staging, "runtime.json", { state: "starting", startedAt: spec.createdAt } satisfies JobRuntime);
			closeSync(openSync(join(staging, "output.log"), "wx", 0o600));
			closeSync(openSync(join(staging, "worker.log"), "wx", 0o600));
			// Catalog readers must never observe a half-created job.
			renameSync(staging, directory);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
		const log = openSync(join(directory, "worker.log"), "a", 0o600);
		try {
			await new Promise<void>((accept, reject) => {
				let settled = false;
				let child: ChildProcess | undefined;
				const onAbort = () => finish(new Error("Job launch aborted"));
				const watcher = watch(directory, check);
				const timer = setTimeout(() => finish(new Error("Job worker did not start within 10 seconds")), 10000);
				try {
					child = spawn(invocation.executable, [...invocation.args, directory], {
						cwd: spec.cwd,
						env: options.env ?? getShellEnv(),
						detached: true,
						stdio: ["ignore", log, log],
						windowsHide: true,
					});
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				function finish(error?: Error) {
					if (settled) return;
					settled = true;
					watcher.close();
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
					if (error) {
						child?.kill("SIGTERM");
						reject(error);
					} else accept();
				}
				function check() {
					try {
						if (readJobRuntime(directory).state !== "starting") finish();
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				}
				watcher.on("error", finish);
				child.once("error", finish);
				child.once("spawn", () => child?.unref());
				child.once("exit", () => {
					check();
					if (!settled) finish(new Error("Job worker exited before launching the command"));
				});
				options.signal?.addEventListener("abort", onAbort, { once: true });
				if (options.signal?.aborted) onAbort();
				check();
			});
		} catch (error) {
			if (readJobRuntime(directory).state === "starting") {
				writeJobRecord(directory, "runtime.json", {
					state: "failed",
					startedAt: spec.createdAt,
					endedAt: Date.now(),
					exitCode: null,
					error: error instanceof Error ? error.message : String(error),
				} satisfies JobRuntime);
			}
			throw new Error(`Failed to launch job ${id}. Worker log: ${join(directory, "worker.log")}`, { cause: error });
		} finally {
			closeSync(log);
		}
		return this.inspect(id);
	}

	/** List jobs, optionally restricted to the current project directory. */
	async list(cwd?: string): Promise<JobInfo[]> {
		let ids: string[];
		try {
			ids = readdirSync(this.directory).filter((id) => /^[a-f0-9-]{36}$/.test(id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const jobs: JobInfo[] = [];
		for (const id of ids) {
			try {
				const spec = readJobSpec(this.jobDirectory(id));
				if (cwd !== undefined && spec.cwd !== resolve(cwd)) continue;
				jobs.push(await this.inspect(id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return jobs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
	}

	/** Read persisted state and verify that a reportedly running worker can still be reached. */
	async inspect(id: string): Promise<JobInfo> {
		const directory = this.jobDirectory(id);
		const spec = readJobSpec(directory);
		if (spec.id !== id) throw new Error("Job metadata does not match its directory");
		let runtime: JobInfo["runtime"] = readJobRuntime(directory);
		if (runtime.state === "running") {
			const running = runtime;
			try {
				runtime = await request(spec, running.port, "status");
			} catch (error) {
				// A missing worker is lost; an existing PID is not proof of identity or liveness.
				let state: "lost" | "unreachable" = "unreachable";
				try {
					process.kill(running.workerPid, 0);
				} catch (cause) {
					if ((cause as NodeJS.ErrnoException).code === "ESRCH") state = "lost";
				}
				const latest = readJobRuntime(directory);
				runtime =
					latest.state !== "running"
						? latest
						: {
								state,
								startedAt: latest.startedAt,
								error: error instanceof Error ? error.message : String(error),
							};
			}
		}
		return {
			id,
			name: spec.name,
			naming: spec.naming,
			command: spec.command,
			cwd: spec.cwd,
			createdAt: spec.createdAt,
			...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
			runtime,
			...readJobProgress(directory),
			logPath: join(directory, "output.log"),
			workerLogPath: join(directory, "worker.log"),
		};
	}

	/** Stop through the authenticated live worker, never by signalling a PID read from disk. */
	async stop(id: string): Promise<JobInfo> {
		const directory = this.jobDirectory(id);
		const spec = readJobSpec(directory);
		const runtime = readJobRuntime(directory);
		if (runtime.state === "starting") throw new Error("Job is still starting");
		if (runtime.state !== "running") return this.inspect(id);
		await request(spec, runtime.port, "stop");
		await new Promise<void>((accept, reject) => {
			const watcher = watch(directory, check);
			const timer = setTimeout(() => finish(new Error("Worker has not confirmed job termination")), 10000);
			function finish(error?: Error) {
				watcher.close();
				clearTimeout(timer);
				if (error) reject(error);
				else accept();
			}
			function check() {
				try {
					if (readJobRuntime(directory).state !== "running") finish();
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			}
			watcher.on("error", finish);
			check();
		});
		return this.inspect(id);
	}

	/** Rename metadata without changing the running process or racing worker-owned status writes. */
	async rename(id: string, name: string): Promise<JobInfo> {
		await this.updateSpec(id, (spec) => ({ ...spec, name, naming: { status: "explicit" } }));
		return this.inspect(id);
	}

	/** Claim an unnamed job once; explicit and already-attempted names are never regenerated. */
	async claimName(id: string): Promise<JobInfo | undefined> {
		const claimed = await this.updateSpec(id, (spec) =>
			spec.naming?.status === "pending" ? { ...spec, naming: { status: "running" } } : undefined,
		);
		return claimed ? this.inspect(id) : undefined;
	}

	/** Publish a naming result only while its claim is current; a manual rename always wins. */
	async finishName(
		id: string,
		result: { status: "generated"; name: string } | { status: "failed"; error: string },
	): Promise<void> {
		await this.updateSpec(id, (spec) => {
			if (spec.naming?.status !== "running") return;
			return result.status === "generated"
				? { ...spec, name: result.name, naming: { status: "generated" } }
				: { ...spec, naming: { status: "failed", error: result.error } };
		});
	}

	/** Stop a live job and start a new job ID, optionally with a replacement command. */
	async restart(id: string, command?: string): Promise<JobInfo> {
		const spec = readJobSpec(this.jobDirectory(id));
		await this.stop(id);
		return this.start(command ?? spec.command, spec.cwd, {
			...(!spec.naming || spec.naming.status === "explicit" ? { name: spec.name } : {}),
			shell: spec.shell,
			timeout: spec.timeout,
			sessionId: spec.sessionId,
		});
	}

	/** Remove a finished or lost job and its logs; active or uncontactable jobs must be stopped first. */
	async remove(id: string): Promise<void> {
		const job = await this.inspect(id);
		if (["starting", "running", "unreachable"].includes(job.runtime.state))
			throw new Error("Stop the job before deleting it");
		rmSync(this.jobDirectory(id), { recursive: true });
	}

	/** Read a bounded log tail; the full log remains available at the returned path. */
	logs(id: string, lines = 200): { text: string; path: string; truncated: boolean } {
		const path = join(this.jobDirectory(id), "output.log");
		const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) throw new Error(`Job output is not a regular file: ${path}`);
			const size = stat.size;
			const buffer = Buffer.allocUnsafe(Math.min(size, 48 * 1024));
			const count = readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
			let start = 0;
			if (size > buffer.length) while (start < count && (buffer[start] & 0xc0) === 0x80) start++;
			const rows = buffer.toString("utf8", start, count).split("\n");
			return { text: rows.slice(-lines).join("\n"), path, truncated: size > count || rows.length > lines };
		} finally {
			closeSync(fd);
		}
	}

	/** Watch one job's state and log files without keeping the initiating pi process alive. */
	watch(
		id: string,
		changed: (file: "runtime.json" | "output.log" | "progress.json" | "spec.json" | undefined) => void,
	): () => void {
		const watcher = watch(this.jobDirectory(id), { persistent: false }, (_event, name) => {
			if (name === "runtime.json" || name === "output.log" || name === "progress.json" || name === "spec.json")
				changed(name);
		});
		watcher.on("error", () => changed(undefined));
		return () => watcher.close();
	}

	private async updateSpec(id: string, update: (spec: JobSpec) => JobSpec | undefined): Promise<boolean> {
		const directory = this.jobDirectory(id);
		// Rex viewers and other pi processes can rename the same job while generation is in flight.
		const release = await lock(join(directory, "spec.json"), {
			realpath: false,
			retries: { retries: 4, minTimeout: 10, maxTimeout: 50 },
		});
		try {
			const next = update(readJobSpec(directory));
			if (!next) return false;
			writeJobRecord(directory, "spec.json", next);
			return true;
		} finally {
			await release();
		}
	}

	private jobDirectory(id: string): string {
		// Trust boundary: tool-supplied IDs must not address files outside the private catalog.
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid job ID");
		return join(this.directory, id);
	}
}

function request(spec: JobSpec, port: number, action: "status" | "stop"): Promise<JobRuntime> {
	return new Promise((accept, reject) => {
		let settled = false;
		const socket = connect({ host: "127.0.0.1", port });
		const timer = setTimeout(() => fail(new Error("Job worker is not responding")), 2000);
		function fail(error: Error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			reject(error);
		}
		socket.once("connect", () =>
			sendPacket(socket, { proof: localProof(spec.token, `job-${action}-request`), action }),
		);
		socket.once("error", fail);
		socket.once("close", () => fail(new Error("Job worker disconnected")));
		receivePackets(socket, (packet) => {
			if (!replyValidator.Check(packet) || !verifyLocalProof(spec.token, "job-reply", packet.proof)) {
				return fail(new Error("Job worker response could not be authenticated"));
			}
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.end();
			accept(packet.runtime);
		});
	});
}
