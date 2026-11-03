import { fork } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { serveDevChannel } from "../src/hosts/dev-channel.ts";
import { capturePublishedLogs } from "../src/runtime/logs.ts";

// Source saves never restart this process or its child. The private channel/SIGUSR2 request explicit restarts.
const root = process.cwd();
const dataDir = process.env.P2_DATA_DIR ?? join(homedir(), ".pi", "p2");
capturePublishedLogs("dev", dataDir);
const resume = JSON.parse(process.env.P2_DEV_RESUME ?? "[]");
if (!Array.isArray(resume) || !resume.every((id) => typeof id === "string")) throw new Error("Invalid dev resume list");
const running = new Set(resume);
// Detached session workers outlive a server that has to be SIGKILLed. Keep their process-group leaders so the
// supervisor can finish the old generation's teardown before starting its replacement.
const workerGroups = new Map();
const workerGenerations = new Map();
const pending = new Map();
let next = 0;
let child;
let ready;
let frozenChild;
let busy = false;
let closing = false;

function start() {
	const current = fork(resolve(root, "src/hosts/server.ts"), [], {
		cwd: root,
		stdio: ["inherit", "inherit", "inherit", "ipc"],
		execArgv: ["--import", resolve(root, "src/source.ts")],
		env: {
			...process.env,
			P2_DEV: "1",
			P2_DEV_SUPERVISOR_PID: String(process.pid),
			P2_DEV_RESUME: JSON.stringify([...running]),
		},
	});
	child = current;
	ready = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Dev server did not become ready within 30 seconds")), 30_000);
		current.on("message", (message) => {
			if (child !== current || !message || typeof message !== "object") return;
			if (message.type === "dev-ready") {
				clearTimeout(timeout);
				resolve();
			}
			if (message.type === "dev-result") {
				const request = pending.get(message.id);
				pending.delete(message.id);
				request?.resolve(message.result);
			}
			if (
				current !== frozenChild &&
				!closing &&
				message.type === "dev-worker" &&
				typeof message.sessionId === "string" &&
				Number.isSafeInteger(message.generation) &&
				message.generation >= 0
			) {
				const previous = workerGenerations.get(message.sessionId);
				if (previous === undefined || message.generation >= previous) {
					workerGenerations.set(message.sessionId, message.generation);
					if (message.running === true && Number.isSafeInteger(message.pid) && message.pid > 0) {
						running.add(message.sessionId);
						workerGroups.set(message.sessionId, message.pid);
					} else if (message.running === false) {
						running.delete(message.sessionId);
						workerGroups.delete(message.sessionId);
					}
				}
			}
		});
		current.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		current.on("close", (code, signal) => {
			clearTimeout(timeout);
			const error = new Error(
				`Dev server exited (${code ?? signal}); fix the source and explicitly request a restart`,
			);
			reject(error);
			if (child === current) child = undefined;
			for (const request of pending.values()) request.reject(error);
			pending.clear();
			// No crash/save retry: the owner controls when another process starts.
		});
	});
	return ready;
}

function isWorkerGroup(pid) {
	try {
		const lock = `CHORD2_LOCK=p2:${realpathSync(dataDir)}:worker:`;
		const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
		if (!environment.some((entry) => entry.startsWith(lock))) return false;
		// /proc/<pid>/stat: fields after the parenthesized command begin with state, ppid, pgrp.
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
		return Number(fields[2]) === pid;
	} catch {
		return false;
	}
}

async function stop() {
	const current = child;
	if (current) {
		await new Promise((done) => {
			const force = setTimeout(() => current.kill("SIGKILL"), 10_000);
			current.once("close", () => {
				clearTimeout(force);
				done();
			});
			current.kill("SIGTERM");
		});
	}
	// A graceful server close already killed these groups. If the deadline killed the server first, its detached
	// workers still own their stores and locks; kill exactly the groups that server reported before replacement.
	for (const pid of workerGroups.values()) {
		if (!isWorkerGroup(pid)) continue;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The server closed it already.
		}
	}
	workerGroups.clear();
	workerGenerations.clear();
}

async function execute(command) {
	if (closing || busy) {
		const result = {
			ok: false,
			message: "Dev command refused: another command is running or the supervisor is closing",
		};
		console.error(`p2 dev: ${result.message}`);
		child?.send({ type: "dev-notice", result });
		return result;
	}
	busy = true;
	try {
		if (command.action === "restart") {
			frozenChild = child;
			child?.send({ type: "dev-notice", result: { ok: true, message: "Restarting server" } });
			console.log(`p2 dev: restarting backend; preserving ${running.size} running workers`);
			await stop();
			if (closing) throw new Error("The dev supervisor is closing");
			await start();
			const result = { ok: true, message: "Restarted server" };
			child?.send({ type: "dev-notice", result });
			console.log(`p2 dev: ${result.message}`);
			return result;
		}
		if (!child) throw new Error("Dev server is not running; request --restart after fixing the source");
		await ready;
		const current = child;
		return await new Promise((resolve, reject) => {
			const id = ++next;
			const timeout = setTimeout(() => {
				pending.delete(id);
				reject(new Error("Dev reload timed out"));
			}, 110_000);
			pending.set(id, {
				resolve: (result) => {
					clearTimeout(timeout);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});
			current.send({ type: "dev-command", id, command }, (error) => {
				if (error) {
					pending.delete(id);
					clearTimeout(timeout);
					reject(error);
				}
			});
		});
	} catch (error) {
		const result = {
			ok: false,
			message: `${command.action === "restart" ? "Restart" : "Reload"} refused: ${error.message}`,
		};
		console.error(`p2 dev: ${result.message}`);
		child?.send({ type: "dev-notice", result });
		return result;
	} finally {
		busy = false;
		frozenChild = undefined;
	}
}

const closeChannel = await serveDevChannel(dataDir, execute);
async function close() {
	if (closing) return;
	closing = true;
	await stop();
	await closeChannel();
}
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void close());
process.on("SIGUSR2", () => void execute({ action: "restart" }));
console.log(`p2 dev supervisor: ${process.pid} (explicit reload/restart controls; no automatic restarts)`);
void start().catch((error) => console.error(`p2 dev: ${error.message}`));
