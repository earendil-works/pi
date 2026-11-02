// A small HTTP client for examples 53 to 55, standing in for a browser and a command-line client: a request to the
// app on loopback, its status, `Set-Cookie` and JSON body.

import { request } from "node:http";

/** An answer: status, the cookie it set (name=value), JSON body (or text). */
export type Answer = { readonly status: number; readonly cookie: string | undefined; readonly body: unknown };

/** `method path` on the app at `port`, with `headers` and a JSON `body`. */
export function call(
	port: number,
	method: string,
	path: string,
	headers: Readonly<Record<string, string>> = {},
	body?: unknown,
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const sent = request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					const text = Buffer.concat(chunks).toString();
					const type = response.headers["content-type"] ?? "";
					const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
					resolve({
						status: response.statusCode ?? 0,
						cookie,
						body: type.includes("json") ? JSON.parse(text) : text,
					});
				});
			},
		);
		sent.on("error", reject);
		sent.end(body === undefined ? undefined : JSON.stringify(body));
	});
}
