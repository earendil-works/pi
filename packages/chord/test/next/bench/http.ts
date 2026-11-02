// Benchmark of the HTTP component (slice 10 §7): a route's overhead per request against a plain Node handler (keep-alive
// round trips, median µs per request over bursts), and `bytes` throughput for a 100 MiB file (`fileResponse`) against
// `pipeline` of a read stream.
// Run by hand from packages/chord (not in CI), pinned:
//   taskset -c 6 node --conditions=source --experimental-strip-types --expose-gc test/next/bench/http.ts
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "node:stream/promises";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { createHttp, fileResponse, Http } from "../../../src/next-node/http/index.ts";

const BURSTS = 7;
const REQUESTS = 2_000;
const FILE = 100 * 1024 * 1024;

/** GETs `path` on `port` over `agent`, reading the whole body; resolves with its length. */
function get(port: number, path: string, agent: Agent): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, agent }, (res) => {
			let length = 0;
			res.on("data", (chunk: Buffer) => {
				length += chunk.length;
			});
			res.on("end", () => resolve(length));
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

/** The median µs per request of `REQUESTS` sequential keep-alive requests, over bursts. */
async function perRequest(port: number, path: string): Promise<number> {
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	for (let i = 0; i < 200; i++) await get(port, path, agent);
	const times: number[] = [];
	for (let burst = 0; burst < BURSTS; burst++) {
		const start = performance.now();
		for (let i = 0; i < REQUESTS; i++) await get(port, path, agent);
		times.push(((performance.now() - start) * 1000) / REQUESTS);
	}
	agent.destroy();
	return median(times);
}

/** MiB/s of downloading `path` once (after one warm-up). */
async function throughput(port: number, path: string): Promise<number> {
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	await get(port, path, agent);
	const times: number[] = [];
	for (let burst = 0; burst < 3; burst++) {
		const start = performance.now();
		await get(port, path, agent);
		times.push(performance.now() - start);
	}
	agent.destroy();
	return FILE / 1024 / 1024 / (median(times) / 1000);
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

const dir = await mkdtemp(join(tmpdir(), "chord-bench-http-"));
const file = join(dir, "big.bin");
await writeFile(file, Buffer.alloc(FILE, 1));

// A plain Node server: the same JSON body, the same file through `pipeline`.
const plain = createServer((req, res) => {
	if (req.url === "/file") {
		res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(FILE) });
		void pipeline(createReadStream(file), res).catch(() => {});
		return;
	}
	const body = JSON.stringify({ ok: true });
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.length) });
	res.end(body);
});
await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
const plainPort = (plain.address() as { port: number }).port;

// The component with Chord's own listener: one plugin with the same route and the file.
const host = createHost({ principal: { kind: "server" }, onError: () => {} });
const http = createHttp(host, { listen: { host: "127.0.0.1", port: 0 }, onError: () => {} }, context);
const plugin = defineFacet((_host, self) => {
	self.contribute(Http, {
		routes: {
			"GET /json": async () => ({ kind: "json", value: { ok: true } }),
			"GET /file": async () => fileResponse(file),
		},
	});
});
await host.load(
	[
		{ name: "chord.http", facet: http.facet },
		{ name: "@bench/routes", facet: plugin },
	],
	context,
);
const { port } = await http.listening(context);

const plainRequest = await perRequest(plainPort, "/json");
const routeRequest = await perRequest(port, "/json");
console.log(
	`request round trip: plain ${plainRequest.toFixed(1)} µs, route ${routeRequest.toFixed(1)} µs (overhead ${(routeRequest - plainRequest).toFixed(1)} µs, ${(((routeRequest - plainRequest) / plainRequest) * 100).toFixed(1)}%)`,
);
const plainBytes = await throughput(plainPort, "/file");
const routeBytes = await throughput(port, "/file");
console.log(`100 MiB file: pipeline ${plainBytes.toFixed(0)} MiB/s, fileResponse ${routeBytes.toFixed(0)} MiB/s`);

await http.close(context);
await host.close(context);
plain.close();
await rm(dir, { recursive: true, force: true });
