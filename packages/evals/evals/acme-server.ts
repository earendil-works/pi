import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const OPENAI_PROVIDER_ID = "acme";
export const OPENAI_MODEL_ID = "acme-chat";
export const OPENAI_PROBE_PROMPT = "Reply with ACME_OK.";
export const OPENAI_PROBE_RESPONSE = "ACME_OK";
export const STREAM_PROVIDER_ID = "acme-stream";
export const STREAM_MODEL_ID = "acme-stream-chat";
export const STREAM_PROBE_PROMPT = "Reply with ACME_STREAM_OK.";
export const STREAM_PROBE_RESPONSE = "ACME_STREAM_OK";

export const STREAM_API_DOCUMENTATION = `${JSON.stringify(
	{
		name: "Acme Streaming API",
		request: {
			method: "POST",
			path: "/generate",
			headers: { "content-type": "application/json", "x-acme-key": "resolved credential" },
			body: { model: STREAM_MODEL_ID, messages: [{ role: "user", content: "Hello" }], stream: true },
		},
		response: {
			contentType: "application/x-ndjson",
			events: [
				{ type: "text_delta", text: "Hello" },
				{ type: "usage", input_tokens: 3, output_tokens: 2 },
				{ type: "done", reason: "stop" },
			],
		},
	},
	null,
	2,
)}\n`;

type ServerMode = "openai" | "stream";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectRequest(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, { "content-type": "text/plain" });
	response.end(message);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of request) body += chunk.toString();
	return JSON.parse(body);
}

export type AcmeServer = {
	start(): Promise<void>;
	stop(): Promise<void>;
	reset(): void;
	origin(): string;
	baseUrl(): string;
	validRequestReceived(): boolean;
};

export function createAcmeServer(mode: ServerMode): AcmeServer {
	let server: Server | undefined;
	let serverOrigin = "";
	let receivedValidRequest = false;

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const expectedPath = mode === "openai" ? "/v1/chat/completions" : "/generate";
		if (request.url !== expectedPath) return rejectRequest(response, 404, "Unknown endpoint");
		if (request.method !== "POST") return rejectRequest(response, 405, "Expected POST");
		if (!request.headers["content-type"]?.startsWith("application/json")) {
			return rejectRequest(response, 415, "Expected application/json");
		}
		let payload: unknown;
		try {
			payload = await readJson(request);
		} catch {
			return rejectRequest(response, 400, "Invalid JSON");
		}
		if (!isRecord(payload)) return rejectRequest(response, 422, "Expected a JSON object");
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const userMessage = messages.find(
			(message): message is Record<string, unknown> => isRecord(message) && message.role === "user",
		);
		const prompt = typeof userMessage?.content === "string" ? userMessage.content : undefined;

		if (mode === "stream") {
			if (request.headers["x-acme-key"] !== "resolved-stream-key") {
				return rejectRequest(response, 401, "Invalid Acme Stream credential");
			}
			if (payload.model !== STREAM_MODEL_ID || prompt === undefined || payload.stream !== true) {
				return rejectRequest(response, 422, "Invalid Acme Stream request");
			}
			receivedValidRequest = prompt === STREAM_PROBE_PROMPT;
			response.writeHead(200, { "content-type": "application/x-ndjson" });
			response.write(`${JSON.stringify({ type: "text_delta", text: "ACME_" })}\n`);
			response.write(`${JSON.stringify({ type: "text_delta", text: "STREAM_OK" })}\n`);
			response.write(`${JSON.stringify({ type: "usage", input_tokens: 4, output_tokens: 3 })}\n`);
			response.end(`${JSON.stringify({ type: "done", reason: "stop" })}\n`);
			return;
		}

		if (request.headers.authorization !== "Bearer resolved-acme-key") {
			return rejectRequest(response, 401, "Invalid Acme credential");
		}
		if (payload.model !== OPENAI_MODEL_ID || prompt === undefined || payload.stream !== true) {
			return rejectRequest(response, 422, "Invalid OpenAI-compatible request");
		}
		receivedValidRequest = prompt === OPENAI_PROBE_PROMPT;
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-acme",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL_ID,
				choices: [{ index: 0, delta: { role: "assistant", content: OPENAI_PROBE_RESPONSE }, finish_reason: null }],
			})}\n\n`,
		);
		response.write(
			`data: ${JSON.stringify({
				id: "chatcmpl-acme",
				object: "chat.completion.chunk",
				created: 0,
				model: OPENAI_MODEL_ID,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 3, completion_tokens: 2 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	}

	return {
		async start() {
			server = createServer((request, response) => void handle(request, response));
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(0, "127.0.0.1", resolve);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Acme fixture server did not bind a TCP port.");
			serverOrigin = `http://127.0.0.1:${address.port}`;
		},
		async stop() {
			if (!server) return;
			await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
			server = undefined;
		},
		reset() {
			receivedValidRequest = false;
		},
		origin: () => serverOrigin,
		baseUrl: () => `${serverOrigin}/v1`,
		validRequestReceived: () => receivedValidRequest,
	};
}
