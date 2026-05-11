import * as fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { MAX_JSON_BODY_BYTES } from "./types.js";

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export async function readJsonBody<T>(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<T> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > maxBytes) throw new HttpError(413, `JSON body exceeds ${maxBytes} bytes`);
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text.trim()) return {} as T;
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new HttpError(400, error instanceof Error ? error.message : String(error));
	}
}

export function sendJson(res: ServerResponse, data: unknown, status = 200, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
	res.end(JSON.stringify(data));
}

export function sendText(res: ServerResponse, text: string, status = 200, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
	res.end(text);
}

export function sendError(res: ServerResponse, error: unknown): void {
	if (error instanceof HttpError) {
		sendText(res, error.message, error.status);
		return;
	}
	sendText(res, error instanceof Error ? error.message : String(error), 500);
}

export function contentTypeFor(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".svg":
			return "image/svg+xml; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

export async function sendStaticFile(res: ServerResponse, root: string, pathname: string): Promise<boolean> {
	const resolvedRoot = path.resolve(root);
	const relative = pathname.replace(/^\/+/, "");
	const filePath = path.resolve(resolvedRoot, relative);
	if (filePath !== resolvedRoot && !filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw new HttpError(404, "Not found");
	}
	try {
		const data = await fs.readFile(filePath);
		res.writeHead(200, { "content-type": contentTypeFor(filePath), "cache-control": "no-cache" });
		res.end(data);
		return true;
	} catch {
		return false;
	}
}

export function requireString(value: unknown, name: string): string {
	if (typeof value !== "string") throw new HttpError(400, `Missing ${name}`);
	return value;
}

export function requireNonEmptyString(value: unknown, name: string): string {
	const text = requireString(value, name).trim();
	if (!text) throw new HttpError(400, `Missing ${name}`);
	return text;
}
