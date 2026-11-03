import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { filterTerminalOutput, MAX_TERMINAL_FRAME } from "../../src/hosts/tui-filter.ts";
import { requireTuiNode, TuiSandbox } from "../../src/hosts/tui-sandbox.ts";

const supported = Number(process.versions.node.split(".")[0]) >= 26;
const sandbox = (source: string, input?: unknown) =>
	new TuiSandbox(source, { input, onMessage: () => {}, onFailure: () => {} });

test("TUI runtime fails clearly below Node 26.5.1", () => {
	for (const version of ["22.19.0", "24.4.1", "26.5.0"])
		assert.throws(() => requireTuiNode(version), /requires Node >=26.5.1/);
	for (const version of ["26.5.1", "26.11.1", "27.0.0"]) requireTuiNode(version);
});

test("terminal output admits only bounded complete allowed sequences", () => {
	const safe =
		"text\r\n\t界\x1b[38;2;1;2;3mred\x1b[0m\x1b[2J\x1b[H\x1b[3A\x1b[?25l\x1b[?2026h\x1b[?2004h\x1b[?1049h\x1b[1;24r";
	assert.equal(filterTerminalOutput(safe), safe);
	for (const sequence of [
		"\x1b]52;c;secret\x07",
		"\x1b]8;;https://evil\x1b\\",
		"\x1b]0;title\x07",
		"\x1bPpayload\x1b\\",
		"\x1b_Gpayload\x1b\\",
		"\x1b^payload\x1b\\",
		"\x1bXpayload\x1b\\",
		"\x1b[?1000h",
		"\x1b[?1006h",
		"\x1b[>7u",
		"\x1b[5n",
		"\x1b[999999999A",
		"\x1b(0",
		"\x9b2J",
		"\x9d52;c;secret\x9c",
		"\x00\x07\x7f",
	]) {
		assert.equal(filterTerminalOutput(`a${sequence}b`), "ab", JSON.stringify(sequence));
	}
	for (const partial of ["\x1b", "\x1b[", "\x1b[12;", "\x1b]52;secret", "\x1bPdata"])
		assert.equal(filterTerminalOutput(`ok${partial}`), "ok");
	assert.throws(() => filterTerminalOutput("x".repeat(MAX_TERMINAL_FRAME + 1)), /64 KiB/);
	assert.throws(() => filterTerminalOutput("界".repeat(MAX_TERMINAL_FRAME)), /64 KiB/);
	// Deterministic fuzz: filtered output must be idempotent and every surviving ESC must be an allowed complete CSI.
	let seed = 123456;
	for (let round = 0; round < 4000; round++) {
		let input = "";
		for (let i = 0; i < 96; i++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			input += String.fromCharCode(seed % 256);
		}
		const result = filterTerminalOutput(input);
		assert.equal(filterTerminalOutput(result), result);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: assert hostile controls were stripped.
		assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/.test(result));
		// biome-ignore lint/suspicious/noControlCharactersInRegex: enumerate surviving CSI sequences.
		assert(!result.replace(/\x1b\[[\d;:?]*[A-Za-z]/g, "").includes("\x1b"));
	}
});

test(
	"permissions drop precedes module evaluation; all machine escape attempts fail",
	{ skip: !supported },
	async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "p2-tui-escape-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const secret = join(directory, "secret.json"),
			output = join(directory, "written"),
			executed = join(directory, "executed");
		writeFileSync(secret, '{"secret":"fixture-only"}');
		const server = createServer();
		let connections = 0;
		server.on("connection", (socket) => {
			connections++;
			socket.destroy();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const address = server.address();
		assert(address && typeof address === "object");
		const source = `
	const permissions=["fs.read","fs.write","worker","net","child","addon","wasi","inspector"];
	if(permissions.some(name=>process.permission.has(name))) throw new Error("bundle evaluated before drop");
	const topLevelDropped=true;
	export default async function ({input,onMessage}) {
	 onMessage(async()=>{
	 const attempts={
	 read:()=>process.getBuiltinModule("fs").readFileSync(input.secret),
	 write:()=>process.getBuiltinModule("fs").writeFileSync(input.output,"bad"),
	 json:()=>import(input.url,{with:{type:"json"}}),
	 require:()=>process.getBuiltinModule("module").createRequire(input.url)(input.secret),
	 file:()=>import(input.url),
	 net:()=>new Promise((resolve,reject)=>{const socket=process.getBuiltinModule("net").connect(input.port,"127.0.0.1");socket.once("error",reject);socket.once("connect",()=>{socket.destroy();resolve()})}),
	 fetch:()=>fetch("http://127.0.0.1:"+input.port),
	 websocket:()=>new Promise((resolve,reject)=>{const socket=new WebSocket("ws://127.0.0.1:"+input.port);socket.addEventListener("error",reject);socket.addEventListener("open",()=>{socket.close();resolve()})}),
	 child:()=>process.getBuiltinModule("child_process").spawnSync(process.execPath,["-e","require('fs').writeFileSync("+JSON.stringify(input.executed)+",'bad')"]),
	 worker:()=>new (process.getBuiltinModule("worker_threads").Worker)("",{eval:true}),
	 binding:()=>process.binding("fs"),
	 inspector:()=>process.getBuiltinModule("inspector").open(),
	 snapshot:()=>process.getBuiltinModule("v8").getHeapSnapshot(),
	 query:()=>process.getBuiltinModule("v8").queryObjects(Object),
	 environmentData:()=>process.getBuiltinModule("worker_threads").getEnvironmentData("fixture"),
	 setEnvironmentData:()=>process.getBuiltinModule("worker_threads").setEnvironmentData("fixture","bad"),
	 report:()=>process.report.getReport(),
	 priority:()=>process.getBuiltinModule("os").setPriority(0,0),
	 signal:()=>process.kill(0,0),
	 broadcast:()=>new BroadcastChannel("private-channel"),
	 broadcastBuiltin:()=>new (process.getBuiltinModule("worker_threads").BroadcastChannel)("private-channel"),
	 rawDescriptorRead:()=>process.getBuiltinModule("fs").readFileSync(0),
	 rawDescriptorWrite:()=>process.getBuiltinModule("fs").writeSync(1,"raw-fd"),
	 loaderHook:()=>process.getBuiltinModule("module").register(input.url),
	 loadEnv:()=>process.loadEnvFile(input.secret),
	 };
	 const blocked={}; for(const [name,attempt] of Object.entries(attempts)){try{await attempt();blocked[name]=false}catch{blocked[name]=true}}
	 process.stdout.write("\\x1b]52;c;raw-secret\\x07");process.stderr.write("raw-stderr");
	 return {blocked,topLevelDropped,env:Object.keys(process.env),portHidden:process.getBuiltinModule("worker_threads").parentPort===undefined};
	 });
	}`;
		const worker = sandbox(source, { secret, output, executed, url: pathToFileURL(secret).href, port: address.port });
		t.after(() => worker.terminate());
		await worker.ready;
		const result = (await worker.request(null)) as {
			blocked: Record<string, boolean>;
			topLevelDropped: boolean;
			env: string[];
			portHidden: boolean;
		};
		assert(result.topLevelDropped);
		assert.deepEqual(result.env, []);
		assert(result.portHidden);
		for (const [name, blocked] of Object.entries(result.blocked)) assert(blocked, name);
		assert.equal(readFileSync(secret, "utf8"), '{"secret":"fixture-only"}');
		assert(!existsSync(output));
		assert(!existsSync(executed));
		assert.equal(connections, 0);
	},
);

test(
	"sandbox close before readiness rejects startup and concurrent termination waits for exit",
	{ skip: !supported },
	async () => {
		const worker = sandbox(`export default async ()=>new Promise(()=>{})`);
		let exited = false;
		worker.worker.once("exit", () => {
			exited = true;
		});
		const first = worker.terminate();
		const second = worker.terminate();
		assert.equal(first, second);
		await assert.rejects(worker.ready, /closed/);
		await second;
		assert(exited);
	},
);

test(
	"sandbox kills huge V8 allocations and watchdog kills external allocations",
	{ skip: !supported, timeout: 20000 },
	async () => {
		for (const source of [
			`export default ({onMessage})=>onMessage(()=>{const held=[];while(true)held.push(new Array(100000).fill('heap'));})`,
			`export default ()=>{const held=[];setInterval(()=>{const b=new Uint8Array(16*1024*1024);b.fill(1);held.push(b)},30)}`,
		]) {
			let failure = "";
			const worker = new TuiSandbox(source, {
				onMessage: () => {},
				onFailure: (message) => {
					failure = message;
				},
				rssLimit: process.memoryUsage().rss + 96 * 1024 * 1024,
				watchdogMs: 10,
			});
			try {
				await worker.ready;
				worker.post(null);
				const deadline = Date.now() + 15000;
				while (!failure && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
				assert.match(failure, /memory|watchdog/);
			} finally {
				await worker.terminate();
			}
		}
	},
);
