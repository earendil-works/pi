import fs from "node:fs";

const task = process.argv.find((arg) => arg.startsWith("Task: "))?.slice(6) ?? "success";
const requestedModelIndex = process.argv.indexOf("--model");
const requestedModel = requestedModelIndex >= 0 ? process.argv[requestedModelIndex + 1] : "fixture-model";

const zeroUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (text, options = {}) => ({
	role: "assistant",
	content: options.toolCall
		? [
				{ type: "text", text },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			]
		: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "fixture",
	model: options.model ?? requestedModel,
	usage: options.usage ?? zeroUsage(),
	stopReason: options.stopReason ?? "stop",
	...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
	timestamp: Date.now(),
});

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const emitMessage = (message) => emit({ type: "message_end", message });

if (task.startsWith("record-argv:")) {
	fs.writeFileSync(task.slice("record-argv:".length), JSON.stringify(process.argv));
	emitMessage(assistant("done"));
} else if (task === "tool-then-final") {
	emitMessage(assistant("working", { stopReason: "toolUse", toolCall: true }));
	setTimeout(() => emitMessage(assistant("finished")), 150);
} else if (task.startsWith("tool-wait:")) {
	const releaseFile = task.slice("tool-wait:".length);
	emitMessage(assistant("working", { stopReason: "toolUse", toolCall: true }));
	const timer = setInterval(() => {
		if (!fs.existsSync(releaseFile)) return;
		clearInterval(timer);
		emitMessage(assistant("finished"));
	}, 10);
} else if (task === "signal") {
	process.kill(process.pid, "SIGTERM");
} else if (task === "error" || task === "model-error") {
	process.stderr.write("stderr evidence\n");
	emitMessage(
		assistant("assistant evidence", {
			stopReason: "error",
			errorMessage: "provider evidence",
		}),
	);
	if (task === "error") process.exitCode = 1;
} else if (task.startsWith("large")) {
	emitMessage(assistant(`${"x".repeat(60 * 1024)}\n${"line\n".repeat(2100)}`));
} else if (task.startsWith("ignore-sigterm:")) {
	fs.writeFileSync(task.slice("ignore-sigterm:".length), String(process.pid));
	process.on("SIGTERM", () => {});
	emitMessage(assistant("partial", { stopReason: "toolUse" }));
	setInterval(() => {}, 1000);
} else if (task.startsWith("hold:")) {
	fs.appendFileSync(task.slice("hold:".length), `${process.pid}\n`);
	setInterval(() => {}, 1000);
} else {
	process.stderr.write(`Unknown fixture task: ${task}\n`);
	process.exitCode = 2;
}
