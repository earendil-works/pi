// Test support for the kit: a kit server started on a temporary data directory with a temporary plugins root (test
// plugins written there import p3's API, as any plugin), closed after its test, and requests to it as a browser or a
// command-line client would make them.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { App, AppError } from "../../src/kit/app.ts";
import type { WorkerOptions } from "../../src/kit/session-workers.ts";
import { type ServerOptions, startServer } from "../../src/kit/start-server.ts";

/** p3's worker entry and its flags, as `server.ts` gives them. */
export const WORKER: WorkerOptions = {
	entry: fileURLToPath(new URL("../../src/bootstrap/worker.ts", import.meta.url)),
	execArgv: ["--conditions=source", "--disable-warning=ExperimentalWarning"],
};

/**
 * A plugin's server facet serving `SessionRoute` in place of the sessions plugin: every session exists but the one
 * named `closed`.
 */
export const ROUTE = [
	'import { constant, defineFacet } from "@earendil-works/p3/v1";',
	'import { SessionRoute } from "@earendil-works/p3/v1/server";',
	"export default defineFacet((host) =>",
	'\thost.serve(SessionRoute, ({ session }) => ({ exists: constant(session !== "closed") })));',
].join("\n");

/** A plugin's server facet with a route (not public) answering who it runs as: `GET /whoami`. */
export const WHOAMI = [
	'import { defineFacet } from "@earendil-works/p3/v1";',
	'import { Http } from "@earendil-works/p3/v1/server";',
	'export default defineFacet((_host, self) => self.contribute(Http, { routes: { "GET /whoami": async (_request, ctx) => ({ kind: "json", value: ctx.principal ?? null }) } }));',
].join("\n");

const directories: string[] = [];
const apps: App[] = [];

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close(context);
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the test. */
export async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "p3-kit-"));
	directories.push(dir);
	return dir;
}

/** Writes the plugin `@test/<dir>` with `files` into the plugins root `root`. */
export async function writePlugin(root: string, dir: string, files: Readonly<Record<string, string>>): Promise<void> {
	await mkdir(join(root, dir), { recursive: true });
	const manifest = JSON.stringify({ name: `@test/${dir}`, private: true, type: "module" });
	for (const [name, text] of Object.entries({ "package.json": manifest, ...files })) {
		await writeFile(join(root, dir, name), text);
	}
}

/** What a test server takes: its plugins (directory name to files), written into its root first, and the kit's options. */
export type KitOptions = {
	readonly plugins?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly dataDir?: string;
	readonly root?: string;
	readonly listen?: ServerOptions["listen"];
	readonly worker?: WorkerOptions;
	/** What the owner's stop over HTTP does: nothing by default. */
	readonly onStop?: () => void;
};

/** A kit server started in a temporary data directory and plugins root, closed after the test, and what it reported. */
export async function kitApp(
	options: KitOptions = {},
): Promise<{ app: App; errors: AppError[]; dataDir: string; root: string; port: number }> {
	const base = await tempDir();
	const dataDir = options.dataDir ?? join(base, "data");
	const root = options.root ?? join(base, "plugins");
	await mkdir(root, { recursive: true });
	for (const [dir, files] of Object.entries(options.plugins ?? {})) await writePlugin(root, dir, files);
	const errors: AppError[] = [];
	const app = await startServer(
		{
			dataDir,
			root,
			listen: options.listen ?? { host: "127.0.0.1", port: 0 },
			version: "0.0.0-test",
			worker: options.worker ?? WORKER,
			onStop: options.onStop ?? (() => {}),
			onError: (error) => errors.push(error),
		},
		context,
	);
	apps.push(app);
	return { app, errors, dataDir, root, port: app.port() };
}

/** An HTTP answer: its status, headers and body text. */
export type Answer = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string };

/** One HTTP request to the server on `port`, as a client on the same machine makes it. */
export function send(
	port: number,
	method: string,
	path: string,
	options: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string } = {},
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const sent = request({ host: "127.0.0.1", port, method, path, headers: options.headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () =>
				resolve({
					status: response.statusCode ?? 0,
					headers: response.headers,
					body: Buffer.concat(chunks).toString(),
				}),
			);
		});
		sent.on("error", reject);
		sent.end(options.body);
	});
}

/** The rejection of `promise`; fails when it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}
