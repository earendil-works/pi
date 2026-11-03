import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { num, str } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT, follow, method, param, remote, serverHost, sessionHost, statusOf } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { SessionStatus } from "../../plugins/status/contract.ts";
import type { Host } from "../../src/runtime/chord.ts";
import type { DevCommand, DevStatus } from "../../src/runtime/dev-protocol.ts";
import { Browser, browserTests } from "./browser.ts";
import { clientHost, holdIn, http, poll, until, webBundle } from "./helpers.ts";

/** A test plugin's probe on session workers (`name`) and its twin on the server (`name-server`): one type, one place. */
function probes(name: string) {
	const variants = {
		reader: { methods: { label: method(undefined, str()), pid: method(undefined, num()) } },
	};
	return {
		worker: remote(name, {
			version: 1,
			params: { session: param.str() },
			hostAddress: sessionHost,
			variants,
		}),
		server: remote(`${name}-server`, {
			version: 1,
			params: {},
			hostAddress: serverHost,
			variants,
		}),
	};
}
const { worker: Probe, server: ServerProbe } = probes("test.dev-probe");
const contractSource = `import { num, obj, str } from "@earendil-works/pi-schema";
import { method, param, remote, serverHost, sessionHost } from "@p2/app/v1";
const variants = { reader: { methods: { label: method(undefined, str()), pid: method(undefined, num()) } } };
export const Probe = remote("test.dev-probe", { version: 1, params: { session: param.str() },
hostAddress: sessionHost, variants });
export const ServerProbe = remote("test.dev-probe-server", { version: 1, params: {}, hostAddress: serverHost, variants });`;
/** A probe facet of `kind` (`server` or `worker`): its probe answers the label and the process id. */
function facetSource(kind: "server" | "worker"): string {
	return `import { defineFacet } from "@p2/app/v1";
import { Probe, ServerProbe } from "./contract.ts";
import { label } from "./nested/label.ts";
const probe = () => ({ variant: "reader" as const, members: { label: async () => label, pid: async () => process.pid } });
export default defineFacet((host) => host.serve(${kind === "server" ? "ServerProbe" : "Probe"}, probe));`;
}

/** A probe facet of `kind` whose eager object serves a route (server) and records its close in `directory`. */
function lifecycleFacet(directory: string, name: string, route: string, kind: "server" | "worker"): string {
	return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineFacet, local } from "@p2/app/v1";
import { Routes } from "@p2/app/v1/server";
import { Probe, ServerProbe } from "./contract.ts";
import { label } from "./nested/label.ts";
const Eager = local(${JSON.stringify(`test.${name}.lifecycle`)}, { version: 1, params: {}, members: {} });
export default defineFacet((host) => {
 const probe = () => ({ variant: "reader" as const, members: { label: async () => label, pid: async () => process.pid } });
 host.serve(${kind === "server" ? "ServerProbe" : "Probe"}, probe);
 host.serve(Eager, (_params, self) => {
  ${kind === "server" ? `self.contribute(Routes, { ${JSON.stringify(`GET ${route}`)}: (_request, response) => response.end(${JSON.stringify(name)}) });` : ""}
  self.open(async () => null, () => writeFileSync(join(${JSON.stringify(directory)}, ${JSON.stringify(`${name}-disposed-`)} + process.pid), "closed"));
  return {};
 });
});`;
}

/** A plugin directory's package.json (Chord's plugins are packages). */
const pluginPackage = (directory: string) =>
	writeFile(
		join(directory, "package.json"),
		JSON.stringify({ name: directory.split("/").at(-1), private: true, type: "module" }),
	);

const emptyFacet = 'import { defineFacet } from "@p2/app/v1"; export default defineFacet(() => {});';
const webFacet = `import "./style.css"; ${emptyFacet}`;

test(
	"manual button/CLI reloads are atomic during streaming; explicit restarts preserve workers and inputs",
	{ timeout: 120_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2-dev-"));
		const project = join(directory, "apps/p2");
		await mkdir(join(project, "scripts"), { recursive: true });
		for (const name of ["src", "plugins", "public"])
			await cp(new URL(`../../${name}`, import.meta.url), join(project, name), { recursive: true });
		for (const name of ["package.json", "tsconfig.json"])
			await copyFile(new URL(`../../${name}`, import.meta.url), join(project, name));
		for (const script of ["dev.mjs", "reload.mjs"])
			await copyFile(new URL(`../../scripts/${script}`, import.meta.url), join(project, "scripts", script));
		await symlink(new URL("../../node_modules", import.meta.url).pathname, join(project, "node_modules"));
		for (const name of ["packages", "node_modules", "tsconfig.json", "tsconfig.base.json"])
			await symlink(new URL(`../../../../${name}`, import.meta.url).pathname, join(directory, name));
		const probeDirectory = join(project, "plugins/dev-probe");
		await mkdir(join(probeDirectory, "nested"), { recursive: true });
		await pluginPackage(probeDirectory);
		await writeFile(join(probeDirectory, "contract.ts"), contractSource);
		await writeFile(join(probeDirectory, "style.css"), ":root { --dev-probe: 1; }");
		await writeFile(join(probeDirectory, "web.tsx"), webFacet);
		const removable = join(project, "plugins/dev-removable");
		await mkdir(join(removable, "nested"), { recursive: true });
		await pluginPackage(removable);
		await writeFile(
			join(removable, "contract.ts"),
			contractSource.replaceAll("test.dev-probe", "test.dev-removable"),
		);
		await writeFile(join(removable, "nested/label.ts"), 'export const label = "removable-plugin";');
		for (const kind of ["server", "worker"] as const)
			await writeFile(
				join(removable, `${kind}.ts`),
				lifecycleFacet(directory, "removable", "/__dev_removable", kind),
			);
		for (const kind of ["server", "worker"] as const)
			await writeFile(join(probeDirectory, `${kind}.ts`), facetSource(kind));
		await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "original";');
		const chatInput = join(project, "plugins/chat/dev-input.ts");
		await writeFile(chatInput, "export const input = (text: string) => text;");
		const chatWorker = join(project, "plugins/chat/worker.ts");
		await writeFile(
			chatWorker,
			`import { input } from "./dev-input.ts";\n${(await readFile(chatWorker, "utf8")).replace("await content(text, files", "await content(input(text), files")}`,
		);
		const child = spawn(process.execPath, ["--import", "./src/source.ts", "scripts/dev.mjs"], {
			cwd: project,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PORT: "0",
				P2_FAKE: "1",
				P2_RADIUS: "0",
				P2_DATA_DIR: join(directory, "data"),
				P2_DEV_RESUME: "[]",
				P2_ALLOWED_HOSTS: "dev.p2.test",
				P2_PUBLIC_URL: "https://dev.p2.test",
			},
		});
		let log = "";
		child.stdout.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		const ports = () => [...log.matchAll(/p2: http:\/\/127\.0\.0\.1:(\d+)/g)].map((match) => Number(match[1]));
		let browser: Host | undefined;
		let page: Browser | undefined;
		try {
			await poll(() => ports().length === 1, 30_000, "initial server");
			const port = ports()[0]!;
			const devState = async () => JSON.parse((await http(ports().at(-1)!, "/__p2_dev")).body) as DevStatus;
			const button = (command: DevCommand) =>
				http(ports().at(-1)!, "/__p2_dev", {
					method: "POST",
					headers: { Origin: `http://127.0.0.1:${ports().at(-1)!}`, "Content-Type": "application/json" },
					body: JSON.stringify(command),
				});
			const cli = (args: string[] = []): Promise<{ code: number; output: string }> =>
				new Promise((resolve, reject) => {
					const command = spawn("npm", ["run", "reload", "--", ...args], {
						cwd: project,
						env: { ...process.env, P2_DATA_DIR: join(directory, "data") },
						stdio: ["ignore", "pipe", "pipe"],
					});
					let output = "";
					command.stdout.on("data", (chunk: Buffer) => {
						output += chunk.toString();
					});
					command.stderr.on("data", (chunk: Buffer) => {
						output += chunk.toString();
					});
					command.on("error", reject);
					command.on("close", (code) => resolve({ code: code ?? 1, output }));
				});
			assert.equal((await stat(join(directory, "data/dev.sock"))).mode & 0o777, 0o600);
			// New/unloaded files do not count, and a loaded runtime edit disappears on exact-content revert.
			assert.equal((await devState()).restartNeeded, false);
			await writeFile(join(project, "src/hosts/unloaded-dev-fixture.ts"), "export const unused = true;");
			await delay(150);
			assert.equal((await devState()).restartNeeded, false);
			const loadedRuntime = join(project, "src/runtime/principals.ts");
			const loadedContent = await readFile(loadedRuntime, "utf8");
			await writeFile(loadedRuntime, `${loadedContent}\n// loaded runtime edit\n`);
			await poll(async () => (await devState()).restartFiles.includes("src/runtime/principals.ts"));
			await writeFile(loadedRuntime, loadedContent);
			await poll(async () => !(await devState()).restartNeeded);
			browser = clientHost(port);
			const sessions = await holdIn(browser, Sessions, {}, "owner");
			const first = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
			const second = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
			const unseen = browser.hold(Probe, { session: second.id }, BACKGROUND_CONTEXT);
			assert.equal(await unseen.label(BACKGROUND_CONTEXT), "original");
			const secondPid = await unseen.pid(BACKGROUND_CONTEXT);
			unseen.release();
			const chat = await holdIn(browser, Chat, { session: first.id, conversation: 1 }, "participant");
			const serverProbe = browser.hold(ServerProbe, {}, BACKGROUND_CONTEXT);
			const workerProbe = browser.hold(Probe, { session: first.id }, BACKGROUND_CONTEXT);
			assert.equal(await workerProbe.label(BACKGROUND_CONTEXT), "original");
			const firstPid = await workerProbe.pid(BACKGROUND_CONTEXT);
			// The server does not import the worker entry; this baseline must come from worker IPC metadata.
			const workerEntry = join(project, "src/hosts/worker.ts");
			const workerContent = await readFile(workerEntry, "utf8");
			await appendFile(workerEntry, "\n// loaded worker entry edit\n");
			await poll(async () => (await devState()).restartFiles.includes("src/hosts/worker.ts"));
			await writeFile(workerEntry, workerContent);
			await poll(async () => !(await devState()).restartNeeded);
			const status = await holdIn(browser, SessionStatus, {}, "reader");
			await until(status.statuses, (value) => Boolean(value?.[first.id]?.running && value?.[second.id]?.running));
			await chat.send({ text: "slow reload-stream-sentinel", requestId: "reload-stream" }, BACKGROUND_CONTEXT);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			let publications = 0;
			const stopView = follow(chat.view, () => publications++);
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "updated";');
			await writeFile(chatInput, 'export const input = (text: string) => text + " switched-code";');
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			await delay(250);
			assert.equal(await serverProbe.label(BACKGROUND_CONTEXT), "original", "Saving does not apply code");
			assert.equal(await workerProbe.label(BACKGROUND_CONTEXT), "original");
			const reloaded = await button({ action: "reload" });
			assert.equal(reloaded.status, 200, reloaded.body);
			assert.match((await devState()).message ?? "", /Reloaded.*dev-probe/);
			assert.deepEqual((await devState()).dirty, []);
			assert.equal(await serverProbe.label(BACKGROUND_CONTEXT), "updated");
			assert.equal(await workerProbe.label(BACKGROUND_CONTEXT), "updated");
			assert(publications > 2, "stream kept publishing through reload");
			assert.equal(await workerProbe.pid(BACKGROUND_CONTEXT), firstPid);
			assert(
				(await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true))?.[first.id]
					?.running,
			);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("reload-stream-sentinel"),
					),
				),
			);
			stopView();
			await chat.send({ text: "code-switch-sentinel", requestId: "code-switch" }, BACKGROUND_CONTEXT);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" &&
							JSON.stringify(entry.model).includes("code-switch-sentinel switched-code"),
					),
				),
			);

			// A valid server candidate and a syntactically broken worker must commit neither side.
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "after-refusal";');
			await writeFile(join(probeDirectory, "worker.ts"), `${facetSource("worker")}\nthis is broken TypeScript !!!`);
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			const failedCommand = await cli();
			assert.equal(failedCommand.code, 1);
			assert.match(failedCommand.output, /Reload refused/);
			assert.equal((await devState()).phase, "error");
			assert((await devState()).dirty.includes("dev-probe"));
			assert(log.includes("Reload refused"));
			assert.equal(await serverProbe.label(BACKGROUND_CONTEXT), "updated");
			assert.equal(await workerProbe.label(BACKGROUND_CONTEXT), "updated");
			await writeFile(join(probeDirectory, "worker.ts"), facetSource("worker"));
			const fixedCommand = await cli(["dev-probe"]);
			assert.equal(fixedCommand.code, 0, fixedCommand.output);
			assert.match(fixedCommand.output, /Reloaded dev-probe/);
			assert.deepEqual((await devState()).dirty, []);
			assert.equal(await workerProbe.label(BACKGROUND_CONTEXT), "after-refusal");
			assert.equal(await serverProbe.label(BACKGROUND_CONTEXT), "after-refusal");
			// A broken web facet refuses the whole reload too: no backend change commits and the old bundle stays served.
			const servedBundle = await webBundle(port);
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "after-web-refusal";');
			await writeFile(join(probeDirectory, "web.tsx"), `${webFacet}\nthis is broken TypeScript !!!`);
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			const webRefusal = await cli();
			assert.equal(webRefusal.code, 1);
			assert.match(webRefusal.output, /Reload refused/);
			assert.equal(await serverProbe.label(BACKGROUND_CONTEXT), "after-refusal");
			assert.equal(await workerProbe.label(BACKGROUND_CONTEXT), "after-refusal");
			assert.deepEqual(await webBundle(port), servedBundle);
			assert.equal((await http(port, servedBundle.script)).status, 200);
			await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "after-refusal";');
			await writeFile(join(probeDirectory, "web.tsx"), webFacet);
			assert.equal((await cli(["dev-probe"])).code, 0);
			assert.equal(ports().length, 1, "plugin saves never recycle the server");

			// A remote owner (proxy + cookie).
			const invitation = JSON.parse((await http(port, "/owner-token")).body) as { token: string };
			const associated = await http(port, "/owner/claim", {
				method: "POST",
				headers: {
					Host: "dev.p2.test",
					Origin: "https://dev.p2.test",
					"X-P2-Proxy-Secret": "1",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(invitation),
			});
			assert.equal(associated.status, 200);
			const cookie = String(associated.headers["set-cookie"]).split(";")[0]!;
			const headers = { Host: "dev.p2.test", "X-P2-Proxy-Secret": "1", Cookie: cookie };
			const original = (await webBundle(port, headers)).script;
			assert.equal((await http(port, "/__p2_dev", { headers: { Host: "dev.p2.test" } })).status, 403);
			assert.equal(
				(await http(port, "/__p2_dev", { method: "POST", body: JSON.stringify({ action: "reload" }) })).status,
				403,
				"Button API requires same-origin POST",
			);
			assert.equal(
				(await http(port, "/dev.sock", { method: "POST", headers, body: JSON.stringify({ action: "reload" }) }))
					.status,
				404,
				"CLI channel is not a public route",
			);
			const missing = await cli(["missing-plugin"]);
			assert.equal(missing.code, 1);
			assert.match(missing.output, /Unknown p2 plugin/);
			assert.deepEqual((await devState()).dirty, []);

			// Browser runtime files are bundle inputs: an edit asks for a restart (or the next reload), never applies.
			const style = join(project, "src/web/style.css");
			const styleContent = await readFile(style, "utf8");
			await appendFile(style, "\n/* runtime web edit */\n");
			await poll(async () => (await devState()).restartFiles.includes("src/web/style.css"));
			await writeFile(style, styleContent);
			await poll(async () => !(await devState()).restartNeeded);
			// A plugin's web edit marks it dirty; its reload makes a new bundle current, retains old files for in-flight
			// pages, and an open page polls the manifest and reloads onto the new one.
			if (browserTests) {
				page = await Browser.start();
				await page.open(`http://127.0.0.1:${port}/`);
				await page.wait(`document.querySelector('.composer textarea') && !document.querySelector('.offline')`);
				await page.evaluate(`window.beforeReload = true`);
			}
			await appendFile(join(probeDirectory, "web.tsx"), "\nconsole.log('web edit');\n");
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			assert.equal((await webBundle(port, headers)).script, original, "Saving does not rebuild");
			assert.equal((await button({ action: "reload" })).status, 200);
			const updated = (await webBundle(port, headers)).script;
			assert.notEqual(updated, original);
			assert.equal((await http(port, original, { headers })).status, 200);
			await page?.wait(
				`window.beforeReload === undefined && document.querySelector('script[type=module]')?.getAttribute('src') === ${JSON.stringify(updated)}`,
			);

			// CSS is a separate output: its edit keeps the script name but changes the complete manifest version, which
			// must still reload an open page.
			const beforeCss = await webBundle(port, headers);
			await page?.evaluate(`window.beforeCssReload = true`);
			await writeFile(join(probeDirectory, "style.css"), ":root { --dev-probe: 2; }");
			await poll(async () => (await devState()).dirty.includes("dev-probe"));
			assert.equal((await button({ action: "reload" })).status, 200);
			const afterCss = await webBundle(port, headers);
			assert.notEqual(afterCss.version, beforeCss.version);
			assert.equal(afterCss.script, beforeCss.script);
			assert.notEqual(afterCss.style, beforeCss.style);
			await page?.wait(
				`window.beforeCssReload === undefined && document.documentElement.dataset.webVersion === ${JSON.stringify(afterCss.version)}`,
			);
			await page?.close();
			page = undefined;
			assert.equal(ports().length, 1);
			const afterSave = async (revision: number, phase = "ready") => {
				await poll(async () => {
					const state = await devState();
					return state.revision > revision && state.dirty.length > 0;
				});
				const result = await button({ action: "reload" });
				assert.equal(result.status, phase === "error" ? 409 : 200, result.body);
				assert.equal((await devState()).phase, phase);
			};
			const Removable = probes("test.dev-removable");
			const removedServer = browser.hold(Removable.server, {}, BACKGROUND_CONTEXT);
			const removedWorker = browser.hold(Removable.worker, { session: first.id }, BACKGROUND_CONTEXT);
			const removedUnseen = browser.hold(Removable.worker, { session: second.id }, BACKGROUND_CONTEXT);
			const serverPid = await removedServer.pid(BACKGROUND_CONTEXT);
			const removedPid = await removedWorker.pid(BACKGROUND_CONTEXT);
			assert.equal(await removedUnseen.label(BACKGROUND_CONTEXT), "removable-plugin");
			assert.equal((await http(port, "/__dev_removable")).body, "removable");
			await chat.send({ text: "slow plugin-removal-sentinel", requestId: "plugin-removal" }, BACKGROUND_CONTEXT);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			let revision = (await devState()).revision;
			await rm(removable, { recursive: true });
			await afterSave(revision);
			// The objects end; their holders wait for a provider again (failed, not served), until released.
			const removedRefs = [removedServer, removedWorker, removedUnseen];
			await poll(() => removedRefs.every((ref) => statusOf(ref) === "failed"));
			for (const ref of removedRefs) ref.release();
			assert.equal((await http(port, "/__dev_removable")).status, 404, "registration was removed");
			for (const pid of [serverPid, removedPid, secondPid])
				await poll(
					async () =>
						(await readFile(join(directory, `removable-disposed-${pid}`), "utf8").catch(() => "")) === "closed",
				);
			assert.equal(await workerProbe.pid(BACKGROUND_CONTEXT), firstPid);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("plugin-removal-sentinel"),
					),
				),
			);
			const afterRemoval = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
			const removalChat = await holdIn(browser, Chat, { session: afterRemoval.id, conversation: 1 }, "participant");
			await removalChat.send({ text: "after-removal", requestId: "after-removal" }, BACKGROUND_CONTEXT);
			await until(removalChat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("after-removal"),
					),
				),
			);

			await chat.send({ text: "slow plugin-addition-sentinel", requestId: "plugin-addition" }, BACKGROUND_CONTEXT);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			revision = (await devState()).revision;
			const addedDirectory = join(project, "plugins/dev-added");
			await mkdir(join(addedDirectory, "nested"), { recursive: true });
			await pluginPackage(addedDirectory);
			await writeFile(
				join(addedDirectory, "contract.ts"),
				contractSource.replaceAll("test.dev-probe", "test.dev-added"),
			);
			await writeFile(join(addedDirectory, "nested/label.ts"), 'export const label = "added-plugin";');
			for (const kind of ["server", "worker"] as const)
				await writeFile(
					join(addedDirectory, `${kind}.ts`),
					lifecycleFacet(directory, "added", "/__dev_added", kind),
				);
			await afterSave(revision);
			const Added = probes("test.dev-added");
			const addedServer = browser.hold(Added.server, {}, BACKGROUND_CONTEXT);
			const addedWorker = browser.hold(Added.worker, { session: first.id }, BACKGROUND_CONTEXT);
			assert.equal(await addedServer.label(BACKGROUND_CONTEXT), "added-plugin");
			assert.equal(await addedWorker.label(BACKGROUND_CONTEXT), "added-plugin");
			const addedSecond = browser.hold(Added.worker, { session: second.id }, BACKGROUND_CONTEXT);
			assert.equal(await addedSecond.label(BACKGROUND_CONTEXT), "added-plugin");
			addedSecond.release();
			assert.equal((await http(port, "/__dev_added")).body, "added", "new host object activated");
			assert.equal(await workerProbe.pid(BACKGROUND_CONTEXT), firstPid);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			await until(chat.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("plugin-addition-sentinel"),
					),
				),
			);
			const afterAddition = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
			const addedAfter = browser.hold(Added.worker, { session: afterAddition.id }, BACKGROUND_CONTEXT);
			assert.equal(await addedAfter.label(BACKGROUND_CONTEXT), "added-plugin");
			addedAfter.release();

			// Removing the plugin ends its objects (Chord v2 removes a held plugin too; its holders wait, not served).
			revision = (await devState()).revision;
			await rm(addedDirectory, { recursive: true });
			await afterSave(revision);
			await poll(() => statusOf(addedServer) === "failed" && statusOf(addedWorker) === "failed");
			addedServer.release();
			addedWorker.release();
			assert.equal((await http(port, "/__dev_added")).status, 404);
			assert.equal(ports().length, 1, "add/remove never restarts the backend");
			assert(!log.includes("Unknown p2 plugin: dev-removable"));
			await chat.send({ text: "slow restart-stream-sentinel", requestId: "restart-stream" }, BACKGROUND_CONTEXT);
			await until(status.statuses, (value) => value?.[first.id]?.busy.includes(1) === true);
			await appendFile(join(project, "src/runtime/loopback-cookie.ts"), "\n// restart runtime\n");
			await poll(async () => (await devState()).restartNeeded);
			await delay(700);
			assert.equal(ports().length, 1, "Runtime saves never restart automatically");
			assert.equal(await workerProbe.pid(BACKGROUND_CONTEXT), firstPid);
			const restarted = await cli(["--restart"]);
			assert.equal(restarted.code, 0, restarted.output);
			assert.match(restarted.output, /Restarted server/);
			await poll(() => ports().length === 2, 30_000, "replacement server");
			await poll(async () => (await devState()).message === "Restarted server");
			assert.equal((await devState()).restartNeeded, false, JSON.stringify((await devState()).restartFiles));
			await browser.close(BACKGROUND_CONTEXT);
			browser = clientHost(ports()[1]!);
			const restored = await holdIn(browser, SessionStatus, {}, "reader");
			// Check running state before making any worker hold: this must not spawn the unseen session on demand.
			await until(restored.statuses, (value) => Boolean(value?.[first.id]?.running && value?.[second.id]?.running));
			for (const [session, pid] of [
				[first, firstPid],
				[second, secondPid],
			] as const) {
				const probe = browser.hold(Probe, { session: session.id }, BACKGROUND_CONTEXT);
				assert.notEqual(await probe.pid(BACKGROUND_CONTEXT), pid);
				probe.release();
			}
			const resumed = await holdIn(browser, Chat, { session: first.id, conversation: 1 }, "participant");
			const completed = await until(resumed.view, (value) =>
				Boolean(
					value?.entries.some(
						(entry) =>
							entry.kind === "pi.assistant" && JSON.stringify(entry.model).includes("restart-stream-sentinel"),
					),
				),
			);
			assert.equal(
				completed?.entries.filter((entry) => entry.kind === "p2.input").length,
				5,
				"restart never resubmits input",
			);
			assert(log.includes("preserving 4 running workers"));
			await appendFile(join(project, "src/hosts/web.ts"), "\n// backend web server restart\n");
			await poll(async () => (await devState()).restartNeeded);
			await delay(500);
			assert.equal(ports().length, 2);
			// The button starts the same supervised path; the old HTTP connection closes during shutdown.
			const fromButton = button({ action: "restart" }).catch(() => undefined);
			await poll(() => ports().length === 3, 30_000);
			await fromButton;
			await poll(async () => (await devState()).message === "Restarted server");
			child.kill("SIGUSR2");
			await poll(() => ports().length === 4, 30_000);
			await poll(async () => (await devState()).message === "Restarted server");
			// Startup refusal reaches the CLI through the supervisor's socket, which survives a failed child.
			const runtimeFile = join(project, "src/runtime/loopback-cookie.ts");
			const validRuntime = await readFile(runtimeFile, "utf8");
			await writeFile(runtimeFile, `${validRuntime}\nthis is broken runtime code !!!\n`);
			await poll(async () => (await devState()).restartNeeded);
			const failedRestart = await cli(["--restart"]);
			assert.equal(failedRestart.code, 1);
			assert.match(failedRestart.output, /Restart refused/);
			await writeFile(runtimeFile, validRuntime);
			await delay(500);
			assert.equal(ports().length, 4, "Fixing source after a failed restart does not retry automatically");
			const recovered = await cli(["--restart"]);
			assert.equal(recovered.code, 0, recovered.output);
			await poll(() => ports().length === 5, 30_000);
		} catch (error) {
			console.error(log);
			throw error;
		} finally {
			await browser?.close(BACKGROUND_CONTEXT);
			await page?.close();
			if (child.exitCode === null && child.signalCode === null) {
				const closed = once(child, "close");
				child.kill("SIGTERM");
				await closed;
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("a forced dev restart reaps locked workers before resuming their stores", { timeout: 60_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2-dev-forced-restart-"));
	const project = join(directory, "apps/p2");
	const dataDir = join(directory, "data");
	await mkdir(join(project, "scripts"), { recursive: true });
	for (const name of ["src", "plugins", "public"])
		await cp(new URL(`../../${name}`, import.meta.url), join(project, name), { recursive: true });
	for (const name of ["package.json", "tsconfig.json"])
		await copyFile(new URL(`../../${name}`, import.meta.url), join(project, name));
	await copyFile(new URL("../../scripts/dev.mjs", import.meta.url), join(project, "scripts/dev.mjs"));
	await symlink(new URL("../../node_modules", import.meta.url).pathname, join(project, "node_modules"));
	for (const name of ["packages", "node_modules", "tsconfig.json", "tsconfig.base.json"])
		await symlink(new URL(`../../../../${name}`, import.meta.url).pathname, join(directory, name));

	// The old server misses its shutdown deadline before SessionHosts.close, and its worker ignores IPC disconnect.
	// This reproduces a detached lock owner that only the supervisor can reap.
	const serverEntry = join(project, "src/hosts/server.ts");
	await writeFile(
		serverEntry,
		(await readFile(serverEntry, "utf8"))
			.replace('import { mkdirSync } from "node:fs";', 'import { existsSync, mkdirSync, rmSync } from "node:fs";')
			.replace(
				"\t\t\t\tawait hosts.close();",
				'\t\t\t\tif (existsSync(join(dataDir, "test-hang-close"))) { rmSync(join(dataDir, "test-hang-close")); await new Promise<void>(() => {}); }\n\t\t\t\tawait hosts.close();',
			),
	);
	const workerEntry = join(project, "src/hosts/worker.ts");
	await writeFile(
		workerEntry,
		(await readFile(workerEntry, "utf8")).replace('process.once("disconnect", () => void stop());', ""),
	);
	const probeDirectory = join(project, "plugins/dev-probe");
	await mkdir(join(probeDirectory, "nested"), { recursive: true });
	await pluginPackage(probeDirectory);
	await writeFile(join(probeDirectory, "contract.ts"), contractSource);
	await writeFile(join(probeDirectory, "nested/label.ts"), 'export const label = "forced-restart";');
	await writeFile(join(probeDirectory, "worker.ts"), facetSource("worker"));

	const environment = {
		...process.env,
		PORT: "0",
		P2_FAKE: "1",
		P2_RADIUS: "0",
		P2_DATA_DIR: dataDir,
		P2_DEV_RESUME: "[]",
	};
	const child = spawn(process.execPath, ["--import", "./src/source.ts", "scripts/dev.mjs"], {
		cwd: project,
		stdio: ["ignore", "pipe", "pipe"],
		env: environment,
	});
	let log = "";
	child.stdout.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		log += chunk.toString();
	});
	const ports = () => [...log.matchAll(/p2: http:\/\/127\.0\.0\.1:(\d+)/g)].map((match) => Number(match[1]));
	let browser: Host | undefined;
	let oldWorkerPid: number | undefined;
	try {
		await poll(() => ports().length === 1, 30_000, "initial server");
		browser = clientHost(ports()[0]!);
		const sessions = await holdIn(browser, Sessions, {}, "owner");
		const session = await sessions.create({ cwd: directory }, BACKGROUND_CONTEXT);
		const probe = browser.hold(Probe, { session: session.id }, BACKGROUND_CONTEXT);
		const oldPid = await probe.pid(BACKGROUND_CONTEXT);
		oldWorkerPid = oldPid;
		const chat = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
		await chat.send({ text: "forced-restart-persisted", requestId: "forced-restart" }, BACKGROUND_CONTEXT);
		await until(chat.view, (value) =>
			Boolean(value?.entries.some((entry) => JSON.stringify(entry.model).includes("forced-restart-persisted"))),
		);

		// An unrelated server never waits for or steals a live data-directory lock.
		const contender = spawn(process.execPath, ["--import", "./src/source.ts", "src/hosts/server.ts"], {
			cwd: project,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...environment, P2_DEV: "0" },
		});
		let contenderLog = "";
		contender.stdout.on("data", (chunk: Buffer) => {
			contenderLog += chunk.toString();
		});
		contender.stderr.on("data", (chunk: Buffer) => {
			contenderLog += chunk.toString();
		});
		const [code] = (await once(contender, "close")) as [number | null];
		assert.notEqual(code, 0);
		assert.match(contenderLog, /Another p2 server uses /);

		await writeFile(join(dataDir, "test-hang-close"), "hang once");
		child.kill("SIGUSR2");
		await poll(() => ports().length === 2, 30_000, "replacement server");
		await browser.close(BACKGROUND_CONTEXT);
		browser = clientHost(ports()[1]!);
		const replacement = browser.hold(Probe, { session: session.id }, BACKGROUND_CONTEXT);
		assert.notEqual(await replacement.pid(BACKGROUND_CONTEXT), oldPid);
		await poll(
			() => {
				try {
					process.kill(oldPid, 0);
					return false;
				} catch {
					return true;
				}
			},
			5000,
			"old worker process exit",
		);
		const restored = await holdIn(browser, Chat, { session: session.id, conversation: 1 }, "participant");
		const view = await until(restored.view, (value) =>
			Boolean(value?.entries.some((entry) => JSON.stringify(entry.model).includes("forced-restart-persisted"))),
		);
		assert.equal(view?.entries.filter((entry) => entry.kind === "p2.input").length, 1);
		assert.doesNotMatch(log, /cannot resume .*locked/);
	} catch (error) {
		console.error(log);
		throw error;
	} finally {
		await browser?.close(BACKGROUND_CONTEXT);
		if (child.exitCode === null && child.signalCode === null) {
			const closed = once(child, "close");
			child.kill("SIGTERM");
			await closed;
		}
		if (oldWorkerPid !== undefined) {
			try {
				process.kill(-oldWorkerPid, "SIGKILL");
			} catch {
				// The fixed supervisor already reaped it.
			}
		}
		await rm(directory, { recursive: true, force: true });
	}
});
