// Responses (slice 10 §2, D5, R6; decision "The HTTP component's security baseline" (4), (6)): routes return
// descriptions and the component turns them into an answer, a status, headers and a body: the default headers first,
// the response's own replacing same-named ones (validated: a CR or LF throws), `json`, `html`, `redirect`, `error`,
// and `bytes` read in 256 KiB pieces as the consumer pulls them (ranges 206/416, `HEAD`, an attachment unless inline,
// safe download names; without a `size`, until an empty read).

import { STATUS_CODES } from "node:http";
import type { JsonValue } from "../../json.ts";
import type { Ctx } from "../../next/host/index.ts";
import type { AnswerHeaders } from "./headers.ts";

/**
 * A route's answer, as a description; `headers` replace same-named default ones (a route widens its own CSP); a list
 * sends one line per value (several `Set-Cookie`).
 */
export type HttpResponse = { readonly headers?: Readonly<Record<string, string | readonly string[]>> } & (
	| { readonly kind: "json"; readonly value: JsonValue; readonly status?: number }
	| { readonly kind: "html"; readonly body: string; readonly status?: number }
	| {
			readonly kind: "bytes";
			readonly mime: string;
			/** The length: `Content-Length` and ranges; without it, read until `read` returns an empty chunk. */
			readonly size?: number;
			/** `length` bytes from `offset` (fewer only at the end of a body without `size`), in the request's scope. */
			readonly read: (offset: number, length: number, ctx: Ctx) => Promise<Uint8Array>;
			/** The file name it is saved under. */
			readonly download?: string;
			/** Shown in the browser instead of saved (an image, a video), with a `sandbox` CSP. */
			readonly inline?: true;
			/** Whether a single range is answered 206 (with `size`). */
			readonly ranges?: boolean;
	  }
	| { readonly kind: "redirect"; readonly to: string; readonly status?: 302 | 303 | 307 }
	| { readonly kind: "error"; readonly status: number; readonly message?: string }
);

/** What the component answers: a status, its headers, and a whole body, a pulled one, or none. */
export type Answer = {
	readonly status: number;
	readonly headers: AnswerHeaders;
	/** A whole body is its text (UTF-8): Node writes a string body in one write with the head. */
	readonly body: string | ReadableStream<Uint8Array> | null;
};

/** A `bytes` body that could not be read whole (a throwing or a short `read`). */
export class ResponseFailure extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ResponseFailure";
	}
}

/**
 * The answer to `request` for `response` over `defaults` (which it changes): throws when a header is invalid (a CR or
 * LF) or the value is no JSON. A `bytes` body that cannot be read whole is reported to `failed` (its stream errors).
 */
export function answerOf(
	response: HttpResponse,
	request: { readonly method: string; header(name: string): string | null },
	defaults: AnswerHeaders,
	ctx: Ctx,
	failed: (error: unknown) => void,
): Answer {
	const headers = defaults;
	for (const name in response.headers) headers.set(name, response.headers[name]!);
	const head = request.method === "HEAD";
	switch (response.kind) {
		case "json":
			return whole(
				response.status ?? 200,
				headers,
				"application/json; charset=utf-8",
				JSON.stringify(response.value),
				head,
			);
		case "html":
			return whole(response.status ?? 200, headers, "text/html; charset=utf-8", response.body, head);
		case "redirect":
			headers.set("Location", response.to);
			return whole(response.status ?? 302, headers, undefined, "", head);
		case "error":
			return errorAnswer(response.status, headers, response.message, head);
		case "bytes":
			return bytesAnswer(response, request, headers, ctx, failed);
	}
}

/** The answer for an error `status` with its reason phrase (or `message`) as plain text. */
export function errorAnswer(status: number, headers: AnswerHeaders, message?: string, head = false): Answer {
	return whole(status, headers, "text/plain; charset=utf-8", message ?? STATUS_CODES[status] ?? "", head);
}

/** `answer` as a Web `Response`. */
export function webResponse(answer: Answer): Response {
	// Bodies are bytes over plain `ArrayBuffer`s (never shared memory); the DOM types ask for exactly that.
	const headers = new Headers();
	for (const [name, value] of answer.headers.lines()) headers.append(name, value);
	return new Response(answer.body as ConstructorParameters<typeof Response>[0], { status: answer.status, headers });
}

/**
 * A whole body: `type` unless a header set one, and its length; none for `HEAD`, and neither for a status that
 * carries no body (204, 205, 304: Sol's recheck N8, `Response` threw on them).
 */
function whole(status: number, headers: AnswerHeaders, type: string | undefined, text: string, head: boolean): Answer {
	if (status < 200 || status > 599) throw new RangeError(`response: status ${status}`);
	if (BODYLESS.has(status)) {
		headers.delete("Content-Type");
		headers.delete("Content-Length");
		return { status, headers, body: null };
	}
	if (type !== undefined && !headers.has("content-type")) headers.set("Content-Type", type);
	headers.set("Content-Length", String(Buffer.byteLength(text)));
	return { status, headers, body: head || text === "" ? null : text };
}

/** The statuses whose responses carry no body. */
const BODYLESS: ReadonlySet<number> = new Set([204, 205, 304]);

/** One `read` of a `bytes` body: 256 KiB. */
const PIECE = 256 * 1024;

/** A `bytes` answer: its range or all of it, or until an empty read without a `size`. */
function bytesAnswer(
	response: Extract<HttpResponse, { readonly kind: "bytes" }>,
	request: { readonly method: string; header(name: string): string | null },
	headers: AnswerHeaders,
	ctx: Ctx,
	failed: (error: unknown) => void,
): Answer {
	if (!headers.has("content-type")) headers.set("Content-Type", response.mime);
	headers.set("Content-Disposition", disposition(response));
	if (response.inline === true)
		headers.set("Content-Security-Policy", `${headers.get("content-security-policy") ?? ""}; sandbox`);
	const { size } = response;
	let start = 0;
	let length = size;
	let status = 200;
	if (size !== undefined && response.ranges === true) {
		headers.set("Accept-Ranges", "bytes");
		const range = rangeOf(request.header("range"), size);
		if (range === "unsatisfiable") {
			headers.set("Content-Range", `bytes */${size}`);
			return whole(416, headers, undefined, "", true);
		}
		if (range !== undefined) {
			({ start, length } = range);
			status = 206;
			headers.set("Content-Range", `bytes ${start}-${start + range.length - 1}/${size}`);
		}
	}
	if (length !== undefined) headers.set("Content-Length", String(length));
	if (request.method === "HEAD" || length === 0) return { status, headers, body: null };
	return { status, headers, body: pulled(response, start, length, ctx, failed) };
}

/**
 * The body of a `bytes` response from `start`, `length` bytes (`undefined`: until an empty read), read one piece per
 * pull, so the consumer's backpressure paces the reads; a `read` that throws or comes back short fails it. It follows
 * the request's scope: once sealed (a disconnect, `close`) the stream errors, no read starts, a late one is dropped
 * (Astra's recheck R2, Sol's N3: a held `Response` went on reading after the seal).
 */
function pulled(
	response: Extract<HttpResponse, { readonly kind: "bytes" }>,
	start: number,
	length: number | undefined,
	ctx: Ctx,
	failed: (error: unknown) => void,
): ReadableStream<Uint8Array> {
	const end = length === undefined ? Number.POSITIVE_INFINITY : start + length;
	const signal = ctx.abortSignal;
	let offset = start;
	let sealed: (() => void) | undefined;
	return new ReadableStream<Uint8Array>(
		{
			start: (controller) => {
				if (signal === undefined) return;
				// Sealed before the stream exists (an abort while the route returned it): no event will come
				// (Sol's third recheck: the request never finished, `close` waited its whole bound).
				if (signal.aborted) return controller.error(signal.reason);
				sealed = () => controller.error(signal.reason);
				signal.addEventListener("abort", sealed, { once: true });
			},
			pull: async (controller) => {
				if (signal?.aborted) return controller.error(signal.reason);
				const want = Math.min(PIECE, end - offset);
				let chunk: Uint8Array;
				try {
					chunk = await response.read(offset, want, ctx);
					if (length !== undefined && chunk.byteLength !== want) {
						throw new ResponseFailure(
							`bytes: read ${chunk.byteLength} of ${want} bytes at ${offset} (size ${response.size})`,
						);
					}
				} catch (error) {
					// A read cut by the seal is no failure of the response.
					if (signal?.aborted) return;
					failed(error);
					controller.error(error);
					return;
				}
				// Sealed while reading: the stream errored already, the late chunk is dropped.
				if (signal?.aborted) return;
				if (chunk.byteLength === 0 || offset + chunk.byteLength >= end) {
					if (chunk.byteLength > 0) controller.enqueue(chunk);
					if (sealed !== undefined) signal?.removeEventListener("abort", sealed);
					controller.close();
					return;
				}
				controller.enqueue(chunk);
				offset += chunk.byteLength;
			},
			cancel: () => {
				if (sealed !== undefined) signal?.removeEventListener("abort", sealed);
			},
		},
		{ highWaterMark: 0 },
	);
}

/**
 * The single range `header` asks for within `size` bytes; `undefined` for none, a malformed or a multi-range one (the
 * whole body); `unsatisfiable` for one starting at or past the end.
 */
function rangeOf(header: string | null, size: number): { start: number; length: number } | "unsatisfiable" | undefined {
	if (header === null) return undefined;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (match === null) return undefined;
	const [, from = "", to = ""] = match;
	if (from === "" && to === "") return undefined;
	if (from === "") {
		const suffix = Number(to);
		if (suffix === 0 || size === 0) return "unsatisfiable";
		const length = Math.min(suffix, size);
		return { start: size - length, length };
	}
	const start = Number(from);
	if (start >= size) return "unsatisfiable";
	const last = to === "" ? size - 1 : Math.min(Number(to), size - 1);
	if (last < start) return undefined;
	return { start, length: last - start + 1 };
}

/**
 * `Content-Disposition`: `inline` or `attachment`, with the download name as an ASCII fallback and as UTF-8 (RFC 6266,
 * RFC 5987), its control and bidirectional formatting characters dropped (a name must read as it is).
 */
function disposition(response: { readonly download?: string; readonly inline?: true }): string {
	const kind = response.inline === true ? "inline" : "attachment";
	if (response.download === undefined) return kind;
	const name = response.download.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
	const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
