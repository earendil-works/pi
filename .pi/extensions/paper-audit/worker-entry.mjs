import { appendLog, updateStatus } from "./src/task-manager.js";
import { runWorker } from "./src/worker.js";

async function main() {
	const cwd = process.env.PI_AUDIT_CWD ?? process.cwd();
	const taskId = process.argv[2];
	if (!taskId) {
		console.error("worker-entry.mjs: missing task id argument");
		process.exit(2);
	}

	try {
		await runWorker({ cwd, taskId });
		process.exit(0);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await appendLog(cwd, taskId, `worker-entry terminal error: ${message}`);
			await updateStatus(cwd, taskId, { state: "failed", error: message });
		} catch {
			// status may not exist; ignore secondary failures.
		}
		process.exit(1);
	}
}

void main();
