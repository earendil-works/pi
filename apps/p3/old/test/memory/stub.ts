// A local stand-in for Anthropic's Messages API and OpenAI's Responses API over HTTPS (a self-signed certificate made
// for the test), streaming server-sent events, for the memory test (`release/memory.test.ts`). No real provider, no
// keys, no network: pi-ai's providers, their SDKs and Node's `fetch` (undici, TLS) run as they would. The last user
// text picks the answer: `[stream]` a slow 8 KB text (about 15 s), `[spawn:N]` N calls of the `subagent` tool,
// `[tool:read]` or `[tool:bash]` a call of that tool (then text once its result came back), else a fast 2 KB text.

import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** A running stub: its URL, its certificate's file (for `NODE_EXTRA_CA_CERTS`) and its close. */
export type Stub = { readonly url: string; readonly certificate: string; close(): Promise<void> };

/** Starts the stub on loopback, with a certificate for `127.0.0.1` made in `dir` (OpenSSL). */
export async function startStub(dir: string): Promise<Stub> {
	const [key, certificate] = [join(dir, "key.pem"), join(dir, "cert.pem")];
	const subject = ["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"];
	const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", certificate];
	execFileSync("openssl", [...args, ...subject], { stdio: "ignore", timeout: 30_000 });
	const server: Server = createServer(
		{ key: await readFile(key), cert: await readFile(certificate) },
		(request, response) => {
			let raw = "";
			request.on("data", (chunk: Buffer) => {
				raw += chunk.toString();
			});
			request.on("end", () => {
				const body = JSON.parse(raw || "{}") as Body;
				const handler = request.url?.startsWith("/v1/messages")
					? anthropic
					: request.url?.startsWith("/v1/responses")
						? openai
						: undefined;
				if (handler === undefined) {
					response.writeHead(404).end();
					return;
				}
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				handler(body, (text) => response.write(text)).then(
					() => response.end(),
					() => response.end(),
				);
			});
		},
	).listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
		certificate,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/** A request's body, as far as the stub reads it. */
type Body = { readonly model?: string; readonly messages?: Message[]; readonly input?: InputItem[] };
type Message = { readonly content: string | readonly { readonly type: string; readonly text?: string }[] };
type InputItem = { readonly type?: string; readonly content?: string | readonly { readonly text?: string }[] };

/** What the stub answers. */
type Plan =
	| { readonly kind: "text"; readonly text: string; readonly delay: number; readonly size: number }
	| { readonly kind: "tool"; readonly name: string; readonly input: object }
	| { readonly kind: "tools"; readonly calls: readonly { readonly name: string; readonly input: object }[] };

const WORDS = "the quick brown fox jumps over a lazy dog while the compiler checks every branch of the program ".split(
	" ",
);

/** About `bytes` of text. */
export function words(bytes: number): string {
	let out = "";
	for (let i = 0; out.length < bytes; i++) out += `${WORDS[i % WORDS.length]}${i % 17 === 16 ? ".\n" : " "}`;
	return out;
}

/** The answer to a last user text, or to a tool's result. */
function planOf(lastText: string, toolResult: boolean): Plan {
	if (toolResult) return { kind: "text", text: words(2000), delay: 0, size: 50 };
	const spawn = /\[spawn:(\d+)\]/.exec(lastText);
	if (spawn !== null) {
		const calls = Array.from({ length: Number(spawn[1]) }, (_, k) => ({
			name: "subagent",
			input: { task: `[stream] child ${k}` },
		}));
		return { kind: "tools", calls };
	}
	if (lastText.includes("[stream]")) return { kind: "text", text: words(8000), delay: 7.5, size: 4 };
	if (lastText.includes("[tool:read]")) return { kind: "tool", name: "read", input: { path: "main.ts" } };
	if (lastText.includes("[tool:bash]"))
		return { kind: "tool", name: "bash", input: { command: "ls -la; head -c 3000 main.ts" } };
	return { kind: "text", text: words(2000), delay: 0, size: 50 };
}

/** `text` in pieces of `size`. */
function pieces(text: string, size: number): string[] {
	return Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, i * size + size));
}

let ids = 0;

/** An Anthropic Messages stream. */
async function anthropic(body: Body, write: (text: string) => void): Promise<void> {
	const last = body.messages?.at(-1);
	const content = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
	const text = content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(" ");
	const plan = planOf(
		text,
		content.some((part) => part.type === "tool_result"),
	);
	const send = (event: string, data: object) =>
		write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
	const usage = { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 1 };
	const message = { id: `msg_${++ids}`, type: "message", role: "assistant", model: body.model, content: [] };
	send("message_start", { message: { ...message, stop_reason: null, stop_sequence: null, usage } });
	if (plan.kind === "text") {
		send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		for (const piece of pieces(plan.text, plan.size)) {
			send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
			if (plan.delay > 0) await sleep(plan.delay);
		}
		send("content_block_stop", { index: 0 });
	} else {
		const calls = plan.kind === "tools" ? plan.calls : [plan];
		calls.forEach((call, index) => {
			const block = { type: "tool_use", id: `toolu_${++ids}`, name: call.name, input: {} };
			send("content_block_start", { index, content_block: block });
			for (const piece of pieces(JSON.stringify(call.input), 10)) {
				send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
			}
			send("content_block_stop", { index });
		});
	}
	const stop = plan.kind === "text" ? "end_turn" : "tool_use";
	send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
	send("message_stop", {});
}

/** An OpenAI Responses stream. */
async function openai(body: Body, write: (text: string) => void): Promise<void> {
	const last = body.input?.at(-1) ?? {};
	const text =
		typeof last.content === "string" ? last.content : (last.content ?? []).map((part) => part.text ?? "").join(" ");
	const plan = planOf(text, last.type === "function_call_output");
	let sequence = 0;
	const send = (type: string, data: object) =>
		write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
	const id = `resp_${++ids}`;
	const usage = {
		input_tokens: Math.ceil(JSON.stringify(body).length / 4),
		input_tokens_details: { cached_tokens: 0 },
		output_tokens: 500,
		output_tokens_details: { reasoning_tokens: 0 },
		total_tokens: 1000,
	};
	const response = (status: string, output: object[]) => ({
		id,
		object: "response",
		created_at: Math.floor(Date.now() / 1000),
		status,
		model: body.model,
		output,
		usage: status === "completed" ? usage : null,
	});
	send("response.created", { response: response("in_progress", []) });
	const output: object[] = [];
	if (plan.kind === "text") {
		const item = { id: `msg_${++ids}`, type: "message", status: "in_progress", role: "assistant", content: [] };
		const at = { item_id: item.id, output_index: 0, content_index: 0 };
		send("response.output_item.added", { output_index: 0, item });
		send("response.content_part.added", { ...at, part: { type: "output_text", text: "", annotations: [] } });
		for (const piece of pieces(plan.text, plan.size)) {
			send("response.output_text.delta", { ...at, delta: piece, logprobs: [] });
			if (plan.delay > 0) await sleep(plan.delay);
		}
		const part = { type: "output_text", text: plan.text, annotations: [] };
		send("response.output_text.done", { ...at, text: plan.text, logprobs: [] });
		send("response.content_part.done", { ...at, part });
		const done = { ...item, status: "completed", content: [part] };
		send("response.output_item.done", { output_index: 0, item: done });
		output.push(done);
	} else {
		const calls = plan.kind === "tools" ? plan.calls : [plan];
		calls.forEach((call, index) => {
			const args = JSON.stringify(call.input);
			const item = {
				id: `fc_${++ids}`,
				type: "function_call",
				status: "in_progress",
				call_id: `call_${ids}`,
				name: call.name,
				arguments: "",
			};
			send("response.output_item.added", { output_index: index, item });
			send("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: args });
			send("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: args });
			const done = { ...item, status: "completed", arguments: args };
			send("response.output_item.done", { output_index: index, item: done });
			output.push(done);
		});
	}
	send("response.completed", { response: response("completed", output) });
}
