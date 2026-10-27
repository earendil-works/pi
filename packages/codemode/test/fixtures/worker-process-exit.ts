import { CodemodeSandbox } from "../../src/runtime/host.ts";

const how = process.argv[2];
if (how !== "abort" && how !== "timeout" && how !== "close") throw new Error(`Unknown stop mode: ${how}`);
const started = performance.now();
process.on("exit", () => {
	console.log(JSON.stringify({ type: "exit", elapsedMs: performance.now() - started }));
});
const controller = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;
let workerExited = false;
const sandbox = new CodemodeSandbox({
	memoryLimitBytes: 256 * 1024 * 1024,
	onWorkerStarted: (exited) => {
		void exited.then(() => {
			workerExited = true;
		});
	},
	tools: [
		{
			name: "ready",
			execute: () => {
				if (how !== "timeout") {
					timer = setTimeout(() => {
						if (how === "abort") controller.abort();
						else void sandbox.close();
					}, 100);
				}
			},
		},
	],
});
try {
	const result = await sandbox.execute(
		"await tools.ready(); return 'a'.repeat(300000).indexOf('a'.repeat(10000) + 'b')",
		{ signal: controller.signal, timeoutMs: how === "timeout" ? 300 : Number.POSITIVE_INFINITY },
	);
	if (result.ok) throw new Error("The script completed instead of being cancelled");
	await sandbox.close();
	console.log(
		JSON.stringify({
			type: "result",
			kind: result.error.kind,
			elapsedMs: performance.now() - started,
			workerExited,
		}),
	);
} finally {
	clearTimeout(timer);
	await sandbox.close();
}
