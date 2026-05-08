#!/usr/bin/env node
// Pi Web Docs — CORS-Mini-Proxy
//
// Zweck: Browser-Anfragen an Infomaniak (oder andere OpenAI-kompatible APIs)
// durchleiten, weil die direkten Calls an api.infomaniak.com keinen
// Access-Control-Allow-Origin-Header zurückgeben → CORS-Block im Browser.
//
// Pfad-Format (vom Frontend erwartet, siehe applyProxyIfNeeded in pi-web-ui):
//   POST /api/proxy/?url=<encoded-baseUrl><path>
// Beispiel:
//   POST /api/proxy/?url=https%3A%2F%2Fapi.infomaniak.com%2F2%2Fai%2F108471%2Fopenai%2Fv1/chat/completions
// Wir parsen ?url= aus der Query, hängen den Pfad an, leiten durch.
//
// Sicherheitsregeln:
// - Whitelist erlaubter Ziel-Hosts (nur Infomaniak)
// - Authorization-Header wird durchgelassen (Browser hält den API-Key)
// - KEIN Logging des Body-Inhalts. Nur Methode, Pfad-Kürzel, Status, Dauer.
// - Streaming wird durch Pipe weitergegeben (für SSE-Responses).

import http from "node:http";
import { request as httpsRequest } from "node:https";

const PORT = Number.parseInt(process.env.PORT || "8090", 10);
const HOST = process.env.HOST || "127.0.0.1";

// Erlaubte Ziel-Hosts (exakter Match auf hostname).
// Bei Bedarf erweiterbar via ENV PROXY_ALLOWED_HOSTS=host1,host2.
const DEFAULT_ALLOWED = ["api.infomaniak.com"];
const ALLOWED_HOSTS = (process.env.PROXY_ALLOWED_HOSTS
	? process.env.PROXY_ALLOWED_HOSTS.split(",").map((s) => s.trim()).filter(Boolean)
	: DEFAULT_ALLOWED);

// Erlaubte Browser-Origins (literal, kein Echo des Request-Origin-Headers,
// um CORS-Misconfiguration zu vermeiden). Bei Migration auf eigene Domain
// hier ergänzen oder via ENV PROXY_ALLOWED_ORIGINS überschreiben.
const ALLOWED_ORIGINS = process.env.PROXY_ALLOWED_ORIGINS
	? process.env.PROXY_ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
	: ["https://docs.og-monschau.de"];

function pickAllowedOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin === "string" && ALLOWED_ORIGINS.includes(origin)) {
		return origin;
	}
	return ALLOWED_ORIGINS[0]; // fallback: erste erlaubte Origin
}

// Headers, die wir vom Client an das Backend durchreichen
const FORWARD_REQUEST_HEADERS = new Set([
	"authorization",
	"content-type",
	"accept",
	"accept-encoding",
	"accept-language",
	"user-agent",
	"x-request-id",
]);

// Headers, die wir vom Backend an den Client durchreichen
const FORWARD_RESPONSE_HEADERS = new Set([
	"content-type",
	"content-encoding",
	"cache-control",
	"x-request-id",
	"x-query-time",
	"x-overall-time",
]);

function logLine(method, urlSummary, status, durationMs, error) {
	const ts = new Date().toISOString();
	const errPart = error ? ` error=${error}` : "";
	process.stdout.write(`${ts} ${method} ${urlSummary} -> ${status} (${durationMs}ms)${errPart}\n`);
}

function shortUrl(targetUrl) {
	try {
		const u = new URL(targetUrl);
		return `${u.host}${u.pathname}`;
	} catch {
		return "<invalid>";
	}
}

const server = http.createServer((req, res) => {
	const startedAt = Date.now();
	const method = req.method || "GET";

	// CORS Preflight: erlauben für unsere Origin (gleicher Host, Browser stellt das nicht direkt — aber sicher ist sicher)
	if (method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": pickAllowedOrigin(req),
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
			"Access-Control-Max-Age": "600",
			Vary: "Origin",
		});
		res.end();
		logLine(method, "(preflight)", 204, Date.now() - startedAt);
		return;
	}

	// req.url enthält Pfad+Query. Wir parsen auf Basis eines Dummy-Hosts.
	const incoming = new URL(req.url || "/", "http://localhost");
	const targetParam = incoming.searchParams.get("url");
	if (!targetParam) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing ?url=<target> query parameter" }));
		logLine(method, incoming.pathname, 400, Date.now() - startedAt, "missing-url");
		return;
	}

	let targetBase;
	try {
		targetBase = new URL(targetParam);
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Invalid ?url= value" }));
		logLine(method, incoming.pathname, 400, Date.now() - startedAt, "invalid-url");
		return;
	}

	if (!ALLOWED_HOSTS.includes(targetBase.hostname)) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Host ${targetBase.hostname} not allowed` }));
		logLine(method, targetBase.hostname, 403, Date.now() - startedAt, "host-not-allowed");
		return;
	}

	// Ziel-URL bauen: targetBase + zusätzlicher Pfad-Suffix vom Proxy-Request
	// Frontend baut: ${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}
	// Dann hängt pi-ai z.B. "/chat/completions" dran → /api/proxy/?url=...&...
	// Browser sendet das als GET/POST mit Pfad /api/proxy/chat/completions?url=...
	// (Tatsächlich landet es als req.url = "/api/proxy/?url=...XYZ/chat/completions"
	//  weil pi-ai die baseUrl direkt so verwendet wie sie ist.)
	// Wir vertrauen darauf, dass targetBase die *vollständige* Ziel-URL ist
	// (inkl. /chat/completions oder /models), die der Client haben will.
	const targetUrl = targetBase;

	// Headers vom Request übernehmen
	const outgoingHeaders = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase()) && typeof v === "string") {
			outgoingHeaders[k] = v;
		} else if (FORWARD_REQUEST_HEADERS.has(k.toLowerCase()) && Array.isArray(v)) {
			outgoingHeaders[k] = v.join(", ");
		}
	}
	outgoingHeaders.host = targetUrl.host;

	const proxyReq = httpsRequest(
		{
			method,
			hostname: targetUrl.hostname,
			port: targetUrl.port || 443,
			path: targetUrl.pathname + targetUrl.search,
			headers: outgoingHeaders,
		},
		(proxyRes) => {
			const responseHeaders = {
				"Access-Control-Allow-Origin": pickAllowedOrigin(req),
				Vary: "Origin",
			};
			for (const [k, v] of Object.entries(proxyRes.headers)) {
				if (FORWARD_RESPONSE_HEADERS.has(k.toLowerCase()) && typeof v === "string") {
					responseHeaders[k] = v;
				} else if (FORWARD_RESPONSE_HEADERS.has(k.toLowerCase()) && Array.isArray(v)) {
					responseHeaders[k] = v.join(", ");
				}
			}
			res.writeHead(proxyRes.statusCode || 502, responseHeaders);
			proxyRes.pipe(res);
			proxyRes.on("end", () => {
				logLine(method, shortUrl(targetUrl.href), proxyRes.statusCode || 0, Date.now() - startedAt);
			});
		},
	);

	proxyReq.on("error", (err) => {
		if (!res.headersSent) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Bad gateway", detail: err.message }));
		}
		logLine(method, shortUrl(targetUrl.href), 502, Date.now() - startedAt, err.code || err.name);
	});

	req.pipe(proxyReq);
});

server.listen(PORT, HOST, () => {
	process.stdout.write(`pi-web-docs CORS proxy listening on ${HOST}:${PORT}, allowed hosts: ${ALLOWED_HOSTS.join(", ")}\n`);
});

// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		process.stdout.write(`\nReceived ${sig}, shutting down\n`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 5000).unref();
	});
}
