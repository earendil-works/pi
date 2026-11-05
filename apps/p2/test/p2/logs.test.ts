import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, isChordError, whenLive } from "@p2/app/v1";
import { LogNotices, Logs } from "../../plugins/logs/contract.ts";
import { resolveConfigValueUncached } from "../../plugins/models/config-value.ts";
import { WorkerControl } from "../../plugins/status/contract.ts";
import {
	captureProcessLogs,
	capturePublishedLogs,
	LogStore,
	logWriter,
	persistLogSource,
	processLogs,
} from "../../src/runtime/logs.ts";
import { expectChord, poll, startFixture, until } from "./helpers.ts";

test("test processes do not install stream capture unless explicitly requested", async () => {
	const stdout = process.stdout.write;
	const stderr = process.stderr.write;
	const stop = captureProcessLogs("not-installed", new LogStore());
	const stopPublished = capturePublishedLogs("dev", "/unused-test-log-directory");
	assert.equal(process.stdout.write, stdout);
	assert.equal(process.stderr.write, stderr);
	stop();
	await stopPublished();
});

test("capture tees a redacted copy while partial writes, binary bytes, encodings and callbacks remain intact", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-log-tee-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const entry = join(directory, "tee.mjs");
	const snapshot = join(directory, "copy.json");
	await writeFile(
		entry,
		`import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { captureProcessLogs, LogStore } from ${JSON.stringify(new URL("../../src/runtime/logs.ts", import.meta.url).href)};
const store = new LogStore(); store.redactor.addSecret("fixture-tee-secret");
// Even legacy options cannot request rewriting the real stream.
const stop = captureProcessLogs("tee", store, { inTests: true, redactOutput: true });
let callbacks = 0;
process.stdout.write("first-", () => { callbacks++; process.send({ phase: "first" }); });
process.on("message", async message => {
 if (message !== "continue") return;
 await new Promise(resolve => process.stdout.write("fixture-tee-secret\\n", () => { callbacks++; resolve(); }));
 process.stdout.write(Buffer.from([0,255,15,128,97,10]));
 process.stderr.write("cea90a", "hex");
 await new Promise(resolve => setImmediate(resolve));
 const bytes = Buffer.alloc(512 * 1024, 120);
 const written = Promise.withResolvers();
 assert.equal(process.stdout.write(bytes, () => { callbacks++; written.resolve(); }), false, "backpressure must not be manufactured");
 await written.promise;
 await new Promise(resolve => setImmediate(resolve));
 stop(); assert.equal(callbacks, 3);
 writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify(store.lines("tee")));
 process.disconnect();
});`,
	);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	t.after(() => child.kill());
	const out: Buffer[] = [],
		err: Buffer[] = [];
	child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
	child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
	const closed = once(child, "close");
	await once(child, "message");
	await poll(() => Buffer.concat(out).length > 0, 3000, "partial stdout is forwarded before newline");
	assert.equal(Buffer.concat(out).toString(), "first-");
	child.send("continue");
	await closed;
	assert.equal(child.exitCode, 0, Buffer.concat(err).toString());
	assert.deepEqual(
		Buffer.concat(out),
		Buffer.concat([
			Buffer.from("first-fixture-tee-secret\n"),
			Buffer.from([0, 255, 15, 128, 97, 10]),
			Buffer.alloc(512 * 1024, 120),
		]),
	);
	assert.deepEqual(Buffer.concat(err), Buffer.from("Ω\n"));
	const copy = await readFile(snapshot, "utf8");
	assert(copy.includes("first-[redacted]"));
	assert(!copy.includes("fixture-tee-secret"));
});

test("node:test completes and reports correctly with capture active throughout its binary reporter stream", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-log-reporter-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	// Deliberately not named *.test.*: the old filename-based stdout exemption missed this valid test file.
	const entry = join(directory, "reporter.mjs");
	await writeFile(
		entry,
		`import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProcessLogs, LogStore } from ${JSON.stringify(new URL("../../src/runtime/logs.ts", import.meta.url).href)};
const original = process.stdout.write;
const stop = captureProcessLogs("reporter", new LogStore(), { inTests: true, redactOutput: true });
assert.notEqual(process.stdout.write, original);
process.once("exit", stop);
test("capture reporter fixture", () => { process.stdout.write("reporter diagnostic\\n"); assert.equal(1 + 1, 2); });
`,
	);
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const child = spawn(process.execPath, ["--test", "--test-reporter=tap", entry], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => child.kill());
	let out = "",
		err = "";
	child.stdout.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		err += chunk.toString();
	});
	await once(child, "close");
	assert.equal(child.exitCode, 0, err);
	assert.match(out, /ok 1 - capture reporter fixture/);
	assert.match(out, /# tests 1/);
	assert.match(out, /# pass 1/);
	assert.match(out, /# fail 0/);
	assert(out.includes("reporter diagnostic"));
});

test("logs redact provider credentials, proxy secrets, cookies and Basic auth before storage; buffers are bounded", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-logs-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(
		join(directory, "auth.json"),
		JSON.stringify({
			faux: { type: "api_key", key: "fixture-provider-key" },
			other: { type: "oauth", access: "fixture-oauth-access", refresh: "fixture-oauth-refresh" },
		}),
	);
	await writeFile(
		join(directory, "models.json"),
		JSON.stringify({ providers: { fixture: { apiKey: "fixture-model-key" } } }),
	);
	await writeFile(join(directory, "owner-key"), "fixture-owner-key");
	const store = new LogStore({ lines: 4, bytes: 500, sources: 2, lineBytes: 128 });
	store.redactor.addDirectory(directory);
	store.redactor.addSecret("fixture-proxy-secret");
	store.redactor.addSecret(
		"http://localhost/callback?code=fixture-url-code&state=fixture-url-state#access_token=fixture-url-access",
	);
	store.redactor.addSecret("  fixture-trimmed-key  ");
	for (const secret of [
		"fixture-provider-key",
		"fixture-oauth-access",
		"fixture-oauth-refresh",
		"fixture-model-key",
		"fixture-owner-key",
		"fixture-proxy-secret",
		"fixture-url-code",
		"fixture-url-state",
		"fixture-url-access",
		"fixture-trimmed-key",
	]) {
		store.append("server", "error", `bare value ${secret}`);
		assert(!JSON.stringify(store.lines("server")).includes(secret));
	}
	for (const text of [
		"Authorization: Basic Zml4dHVyZTpzZWNyZXQ=",
		"Cookie: p2-owner=fixture-cookie; session=another-cookie",
		"Set-Cookie: session=fixture-cookie; HttpOnly",
		"https://fixture-user:fixture-password@host.test/path",
		'"apiKey": "fixture-unknown-key"',
		"token=fixture-unknown-token&next=safe",
		"Bearer fixture-bearer-token",
	]) {
		store.append("server", "stderr", text);
		assert(!JSON.stringify(store.lines("server")).includes("fixture-"));
	}
	await writeFile(join(directory, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "fixture-new-key" } }));
	store.append("server", "error", "fixture-new-key fixture-provider-key");
	assert(!JSON.stringify(store.lines("server")).includes("fixture-"), "rotated and prior secrets stay protected");
	for (let index = 0; index < 20; index++) store.append("server", "event", `line-${index}`);
	assert.deepEqual(
		store.lines("server").map((line) => line.text),
		["line-16", "line-17", "line-18", "line-19"],
	);
	store.append("server", "stdout", "oversized".repeat(100));
	assert(store.lines("server").at(-1)?.text.includes("omitted"));
	const copy = store.lines("server");
	copy[0].text = "mutated";
	assert(!store.lines("server").some((line) => line.text === "mutated"));
	store.append("worker:a", "event", "one");
	store.append("worker:b", "event", "two");
	assert.equal(store.sources().length, 2);
	assert.deepEqual(store.lines("server"), []);
	const bytes = new LogStore({ bytes: 10 });
	bytes.append("server", "stdout", "12345");
	bytes.append("server", "stdout", "67890");
	bytes.append("server", "stdout", "abcde");
	assert.deepEqual(
		bytes.lines("server").map((line) => line.text),
		["67890", "abcde"],
	);
});

test("notices redact and bound messages, replace the prior source notice and tolerate malformed Unicode secrets", () => {
	const store = new LogStore({ lineBytes: 128 });
	store.redactor.addSecret("fixture-notice-value");
	store.redactor.addSecret(String.fromCharCode(0xd800));
	for (let index = 0; index < 60; index++) store.notice(`worker:${index}`, "fixture-notice-value");
	assert.equal(store.notices().length, 50);
	assert(store.notices().every((notice) => notice.message === "[redacted]"));
	store.notice("worker:59", "x".repeat(1000));
	assert.equal(store.notices().length, 50);
	assert.equal(store.notices().at(-1)?.message, "[oversized error message omitted]");
	store.dismissNotice(store.notices().at(-1)!.id);
	assert.equal(store.notices().length, 49);
});

test("log writers join split secrets and UTF-8, bound partial lines and flush on exit", () => {
	const store = new LogStore();
	store.redactor.addSecret("fixture-split-secret");
	const forwarded: string[] = [];
	const writer = logWriter("worker", "stderr", store, (line) => forwarded.push(line));
	writer.write("start fixture-split-");
	writer.write("secret ");
	const bytes = Buffer.from("Ω\nlast");
	writer.write(bytes.subarray(0, 1));
	writer.write(bytes.subarray(1));
	assert.deepEqual(
		store.lines("worker").map((line) => line.text),
		["start [redacted] Ω"],
	);
	assert.deepEqual(forwarded, ["start [redacted] Ω"], "the parent receives already-redacted worker lines");
	writer.end();
	assert.equal(store.lines("worker").at(-1)?.text, "last");
	writer.write("x".repeat(100_000));
	writer.write("\nnext\n");
	assert.deepEqual(
		store
			.lines("worker")
			.slice(-2)
			.map((line) => line.text),
		["[oversized log line omitted]", "next"],
	);
});

test("resolved provider keys and custom auth-header commands are registered before logging", () => {
	assert.equal(resolveConfigValueUncached("$CUSTOM", { CUSTOM: "fixture-custom-value" }), "fixture-custom-value");
	assert.equal(resolveConfigValueUncached("!printf fixture-command-value"), "fixture-command-value");
	assert.equal(processLogs.redactor.redact("fixture-custom-value fixture-command-value"), "[redacted] [redacted]");
});

test("forked hosts capture stdout/stderr, including failed startup diagnostics", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-log-child-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const entry = join(directory, "child.mjs");
	await writeFile(
		entry,
		`process.stdout.write("fixture child stdout\\n");
process.stderr.write("fixture child stderr\\n");
process.send({ chord2control: { type: "fatal", message: "Unknown p2 plugin: settings" } });
setTimeout(() => process.exit(1), 100);`,
	);
	const store = new LogStore();
	const writers = { stdout: logWriter("worker", "stdout", store), stderr: logWriter("worker", "stderr", store) };
	// As the session workers feed a worker's output to its log (Chord's createWorkers `onOutput`).
	const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
	child.stdout?.on("data", (bytes: Buffer) => writers.stdout.write(bytes));
	child.stderr?.on("data", (bytes: Buffer) => writers.stderr.write(bytes));
	const [fatal] = await Promise.all([new Promise((resolve) => child.once("message", resolve)), once(child, "close")]);
	assert.match(JSON.stringify(fatal), /Unknown p2 plugin: settings/);
	writers.stdout.end();
	writers.stderr.end();
	assert.deepEqual(
		store.lines("worker").map(({ level, text }) => ({ level, text })),
		[
			{ level: "stdout", text: "fixture child stdout" },
			{ level: "stderr", text: "fixture child stderr" },
		],
	);
	assert.equal(child.exitCode, 1);
});

test("detached preload stores fatal startup errors redacted, even when the main module cannot parse", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "p2-log-preload-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(
		join(directory, "auth.json"),
		JSON.stringify({ faux: { type: "api_key", key: "fixture-startup-secret" } }),
	);
	const entry = join(directory, "broken.mjs");
	await writeFile(entry, 'throw new Error("fixture-startup-marker fixture-startup-secret");');
	for (const brokenSyntax of [false, true]) {
		if (brokenSyntax) await writeFile(entry, "const value = !!!; // fixture-startup-secret");
		const child = spawn(
			process.execPath,
			["--import", new URL("../../plugins/terminals/log-preload.ts", import.meta.url).href, entry, directory],
			{ stdio: "ignore", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
		);
		await once(child, "close");
		assert.equal(child.exitCode, 1);
		const text = await readFile(join(directory, "terminals.logs.json"), "utf8");
		assert(!text.includes("fixture-startup-secret"));
		assert(text.includes(brokenSyntax ? "SyntaxError" : "fixture-startup-marker"));
	}
});

test("owner-only Logs exposes live per-source state without starting workers, and imports bounded detached snapshots", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const owner = fixture.browser();
	const source = `session:fixture-${Date.now()}`;
	const logs = owner.hold(Logs, { source }, BACKGROUND_CONTEXT);
	const server = owner.hold(Logs, { source: "server" }, BACKGROUND_CONTEXT);
	await whenLive(logs);
	await whenLive(server);
	processLogs.append(source, "error", "Unknown p2 plugin: settings");
	await until(logs.lines, (lines) => lines?.some((line) => line.text.includes("Unknown p2 plugin")) === true);
	assert(!server.lines.value?.some((line) => line.text.includes("Unknown p2 plugin")));
	await until(logs.sources, (sources) => sources?.some((entry) => entry.id === source) === true);
	const notices = owner.hold(LogNotices, {}, BACKGROUND_CONTEXT);
	processLogs.redactor.addSecret("fixture-notice-secret");
	processLogs.notice(source, "Failed facet fixture-notice-secret");
	const seen = await until(notices.notices, (value) => value?.some((notice) => notice.source === source) === true);
	const notice = seen!.find((entry) => entry.source === source)!;
	assert.equal(notice.message, "Failed facet [redacted]");
	await notices.dismiss({ id: notice.id }, BACKGROUND_CONTEXT);
	// The answer follows its state: the notice is gone on the page when the call resolves.
	assert(!notices.notices.value.some((entry) => entry.id === notice.id));
	const terminals = owner.hold(Logs, { source: "terminals" }, BACKGROUND_CONTEXT);
	const store = new LogStore();
	store.redactor.addSecret("fixture-detached-secret");
	const path = join(fixture.dataDir, "terminals.logs.json");
	const stop = persistLogSource("terminals", path, store);
	store.append("terminals", "event", "detached-host fixture-detached-secret");
	await stop();
	assert(!(await readFile(path, "utf8")).includes("fixture-detached-secret"));
	await until(terminals.lines, (lines) => lines?.some((line) => line.text === "detached-host [redacted]") === true);
	const guest = fixture.as({
		kind: "guest",
		id: "g",
		name: "Guest",
		home: "s",
		sessions: { s: "full" },
		revision: 1,
	});
	const denied = guest.hold(Logs, { source }, BACKGROUND_CONTEXT);
	await expectChord(whenLive(denied), "forbidden");
	// A refused reference has no state: reading it throws the refusal.
	assert.throws(
		() => denied.sources.value,
		(error) => isChordError(error, "forbidden"),
	);
	assert.throws(
		() => denied.lines.value,
		(error) => isChordError(error, "forbidden"),
	);
	denied.release();
	const deniedNotices = guest.hold(LogNotices, {}, BACKGROUND_CONTEXT);
	await expectChord(whenLive(deniedNotices), "forbidden");
	await expectChord(deniedNotices.dismiss({ id: notice.id }, BACKGROUND_CONTEXT), "forbidden");
	deniedNotices.release();
	const deniedRetry = guest.hold(WorkerControl, { session: "s" }, BACKGROUND_CONTEXT);
	await expectChord(whenLive(deniedRetry), "forbidden");
	await expectChord(deniedRetry.restart(BACKGROUND_CONTEXT), "forbidden");
	deniedRetry.release();
	const worker = fixture
		.as({ kind: "worker", session: "s", generation: 1 })
		.hold(Logs, { source }, BACKGROUND_CONTEXT);
	await expectChord(whenLive(worker), "forbidden");
	worker.release();
});
