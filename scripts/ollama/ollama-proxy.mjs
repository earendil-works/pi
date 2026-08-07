#!/usr/bin/env node
/**
 * Local LLM model proxy for pi.
 *
 * Sits between pi and a local Ollama server, forwarding every HTTP request
 * (including streaming responses) to Ollama. pi talks to the proxy's
 * OpenAI-compatible endpoint (http://127.0.0.1:11435/v1 by default).
 *
 * Usage:
 *   node scripts/ollama/ollama-proxy.mjs [options]
 *
 * Options:
 *   --port <port>     Port the proxy listens on (default: 11435, env: PI_OLLAMA_PROXY_PORT)
 *   --host <host>     Address the proxy binds to (default: 127.0.0.1)
 *   --ollama <url>    Ollama server URL (default: env OLLAMA_HOST or http://127.0.0.1:11434)
 *   --quiet           Do not log individual requests
 *   --help            Show this help
 *
 * Endpoints:
 *   /healthz          Proxy + Ollama health as JSON (used by pi-with-ollama.mjs)
 *   /*                Everything else is forwarded to Ollama verbatim
 *
 * Works on Linux, macOS, and Windows (requires Node.js 18+).
 */

import http from "node:http";
import { URL } from "node:url";

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function printHelp() {
	console.log(`ollama-proxy - local LLM model proxy for pi

Usage: node scripts/ollama/ollama-proxy.mjs [options]

Options:
  --port <port>    Port the proxy listens on (default: 11435, env: PI_OLLAMA_PROXY_PORT)
  --host <host>    Address the proxy binds to (default: 127.0.0.1)
  --ollama <url>   Ollama server URL (default: env OLLAMA_HOST or http://127.0.0.1:11434)
  --quiet          Do not log individual requests
  --help           Show this help`);
}

/** OLLAMA_HOST may be "host:port" or "http://host:port"; normalize to a URL string. */
function normalizeOllamaUrl(raw) {
	let url = raw.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(url)) {
		url = `http://${url}`;
	}
	return url;
}

function parseArgs(argv) {
	const options = {
		port: Number(process.env.PI_OLLAMA_PROXY_PORT) || 11435,
		host: "127.0.0.1",
		ollama: normalizeOllamaUrl(process.env.OLLAMA_HOST || "http://127.0.0.1:11434"),
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--port":
				options.port = Number(argv[++i]);
				break;
			case "--host":
				options.host = argv[++i];
				break;
			case "--ollama":
				options.ollama = normalizeOllamaUrl(argv[++i] ?? "");
				break;
			case "--quiet":
				options.quiet = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				console.error(`Unknown option: ${arg}`);
				printHelp();
				process.exit(1);
		}
	}
	if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535) {
		console.error(`Invalid --port value: ${options.port}`);
		process.exit(1);
	}
	return options;
}

async function fetchJson(url, init) {
	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`${init?.method ?? "GET"} ${url} failed: HTTP ${response.status}`);
	}
	return response.json();
}

async function checkOllama(ollamaUrl) {
	const version = await fetchJson(`${ollamaUrl}/api/version`);
	const tags = await fetchJson(`${ollamaUrl}/api/tags`);
	const models = (tags.models ?? []).map((model) => model.name ?? model.model).filter(Boolean);
	return { version: version.version ?? "unknown", models };
}

function proxyRequest(clientRequest, clientResponse, ollamaUrl, quiet) {
	const startedAt = Date.now();
	const target = new URL(clientRequest.url, ollamaUrl);

	const headers = {};
	for (const [name, value] of Object.entries(clientRequest.headers)) {
		if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "host") {
			headers[name] = value;
		}
	}

	const upstreamRequest = http.request(
		target,
		{ method: clientRequest.method, headers },
		(upstreamResponse) => {
			const responseHeaders = {};
			for (const [name, value] of Object.entries(upstreamResponse.headers)) {
				if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
					responseHeaders[name] = value;
				}
			}
			clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
			upstreamResponse.pipe(clientResponse);
			upstreamResponse.on("end", () => {
				if (!quiet) {
					const elapsed = Date.now() - startedAt;
					console.log(
						`${clientRequest.method} ${clientRequest.url} -> ${upstreamResponse.statusCode} (${elapsed}ms)`,
					);
				}
			});
		},
	);

	upstreamRequest.on("error", (error) => {
		if (!quiet) {
			console.error(`${clientRequest.method} ${clientRequest.url} -> upstream error: ${error.message}`);
		}
		if (!clientResponse.headersSent) {
			clientResponse.writeHead(502, { "content-type": "application/json" });
		}
		clientResponse.end(
			JSON.stringify({
				error: {
					message: `ollama-proxy could not reach Ollama at ${ollamaUrl}: ${error.message}. Is 'ollama serve' running?`,
					type: "upstream_unreachable",
				},
			}),
		);
	});

	clientRequest.on("aborted", () => upstreamRequest.destroy());
	clientRequest.pipe(upstreamRequest);
}

async function handleHealth(clientResponse, ollamaUrl) {
	try {
		const { version, models } = await checkOllama(ollamaUrl);
		clientResponse.writeHead(200, { "content-type": "application/json" });
		clientResponse.end(JSON.stringify({ status: "ok", proxy: "ollama-proxy", ollama: { url: ollamaUrl, version, models } }));
	} catch (error) {
		clientResponse.writeHead(503, { "content-type": "application/json" });
		clientResponse.end(
			JSON.stringify({
				status: "error",
				proxy: "ollama-proxy",
				ollama: { url: ollamaUrl, error: error instanceof Error ? error.message : String(error) },
			}),
		);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));

	console.log(`ollama-proxy: forwarding to ${options.ollama}`);
	try {
		const { version, models } = await checkOllama(options.ollama);
		console.log(`ollama-proxy: Ollama ${version} is reachable, ${models.length} model(s) available`);
		for (const model of models) {
			console.log(`  - ${model}`);
		}
		if (models.length === 0) {
			console.warn("ollama-proxy: no models installed. Pull one first, e.g.: ollama pull qwen2.5-coder:7b");
		}
	} catch (error) {
		console.warn(`ollama-proxy: warning: Ollama is not reachable at ${options.ollama} (${error.message}).`);
		console.warn("ollama-proxy: start it with 'ollama serve' (or open the Ollama app). The proxy will keep running.");
	}

	const server = http.createServer((request, response) => {
		if (request.url === "/healthz") {
			void handleHealth(response, options.ollama);
			return;
		}
		proxyRequest(request, response, options.ollama, options.quiet);
	});

	server.on("error", (error) => {
		if (error.code === "EADDRINUSE") {
			console.error(`ollama-proxy: port ${options.port} is already in use on ${options.host}.`);
			console.error("ollama-proxy: is another proxy instance running? Use --port to pick a different port.");
		} else {
			console.error(`ollama-proxy: server error: ${error.message}`);
		}
		process.exit(1);
	});

	server.listen(options.port, options.host, () => {
		const base = `http://${options.host}:${options.port}`;
		console.log(`ollama-proxy: listening on ${base}`);
		console.log(`ollama-proxy: OpenAI-compatible endpoint for pi: ${base}/v1`);
		console.log(`ollama-proxy: health check: ${base}/healthz`);
		console.log("ollama-proxy: next step: node scripts/ollama/pi-with-ollama.mjs");
		console.log("ollama-proxy: press Ctrl+C to stop");
	});

	const shutdown = () => {
		console.log("\nollama-proxy: shutting down");
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 1000).unref();
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((error) => {
	console.error(`ollama-proxy: fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
