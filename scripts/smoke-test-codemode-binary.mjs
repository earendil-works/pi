#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const WORKER_MARKER = "PI_CODEMODE_WORKER_OK";
const SUCCESS_MARKER = "PI_CODEMODE_BINARY_SMOKE_OK";
const FAILURE_MARKER = "PI_CODEMODE_BINARY_SMOKE_FAILED";
const TIMEOUT_MS = 30_000;

function completionChunk(id, delta, finishReason = null, usage) {
	return {
		id,
		object: "chat.completion.chunk",
		created: 0,
		model: "codemode-smoke",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	};
}

function sendCompletion(response, chunks) {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "close",
	});
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

async function readRequest(request) {
	let body = "";
	for await (const chunk of request) body += chunk.toString();
	return body;
}

function toolResultContainsMarker(body) {
	const payload = JSON.parse(body);
	return (
		Array.isArray(payload.messages) &&
		payload.messages.some(
			(message) => message?.role === "tool" && JSON.stringify(message.content).includes(WORKER_MARKER),
		)
	);
}

async function main() {
	const binaryArg = process.argv[2];
	if (!binaryArg || process.argv.length !== 3) {
		throw new Error("Usage: node scripts/smoke-test-codemode-binary.mjs <pi-binary>");
	}
	const binary = resolve(binaryArg);
	const tempDir = await mkdtemp(join(tmpdir(), "pi-codemode-binary-smoke-"));
	let requestCount = 0;
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const body = await readRequest(request);
		requestCount++;
		const id = `chatcmpl-codemode-smoke-${requestCount}`;
		if (requestCount === 1) {
			sendCompletion(response, [
				completionChunk(id, {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "call_codemode_smoke",
							type: "function",
							function: {
								name: "codemode",
								arguments: JSON.stringify({ code: `text("${WORKER_MARKER}")` }),
							},
						},
					],
				}),
				completionChunk(id, {}, "tool_calls", { prompt_tokens: 1, completion_tokens: 1 }),
			]);
			return;
		}
		const marker = toolResultContainsMarker(body) ? SUCCESS_MARKER : FAILURE_MARKER;
		sendCompletion(response, [
			completionChunk(id, { role: "assistant", content: marker }),
			completionChunk(id, {}, "stop", { prompt_tokens: 1, completion_tokens: 1 }),
		]);
	});

	try {
		await new Promise((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Smoke-test server did not bind to a TCP port");
		await writeFile(
			join(tempDir, "models.json"),
			JSON.stringify({
				providers: {
					"codemode-smoke": {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						apiKey: "smoke-test",
						models: [{ id: "codemode-smoke" }],
					},
				},
			}),
		);

		const piArgs = [
			"--provider",
			"codemode-smoke",
			"--model",
			"codemode-smoke",
			"--tools",
			"codemode",
			"--print",
			"--no-session",
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"Run the codemode binary smoke test.",
		];
		const javaScript = extname(binary) === ".js";
		const child = spawn(javaScript ? process.execPath : binary, javaScript ? [binary, ...piArgs] : piArgs, {
			cwd: tempDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: tempDir,
				PI_OFFLINE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const exitCode = await new Promise((resolveExit, reject) => {
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error(`Smoke test timed out after ${TIMEOUT_MS} ms`));
			}, TIMEOUT_MS);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolveExit(code);
			});
		});
		if (exitCode !== 0 || !stdout.includes(SUCCESS_MARKER) || requestCount < 2) {
			throw new Error(
				`Codemode binary smoke test failed (exit ${exitCode}, requests ${requestCount})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		process.stdout.write(stdout);
	} finally {
		await new Promise((resolveClose) => server.close(resolveClose));
		await rm(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
