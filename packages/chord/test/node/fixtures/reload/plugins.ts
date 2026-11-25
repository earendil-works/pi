// The reload suite's plugins, as the files a test writes into the app's root and edits on disk: `counter` (a counter
// with a persisted document and a table, on a worker or the server, pure or holding a native, at any contract
// version), `latch` (on every worker: the test's hand on calls that wait), and web plugins showing the counter with
// a draft input (component state) and a kept input (page state). Calls that must be in flight during a reload wait on
// a latch by name: the method marks it entered, then waits until the test opens it. Latches live on `globalThis`, so
// old and new code of a plugin and the latch plugin share them within a process.

/** Where the counter runs: a project's worker (`p1`), or the server. */
export type Placement = "server" | "worker";

/**
 * The counter's contract as a version of its code has it: `v1`; `v2` evolved (its label an object, `add` taking and
 * returning objects) for a provider that accepts v1 (`accepted`) or does not (`refused`), the same file either way.
 */
export type ContractVersion = "v1" | "v2";

/** The latches, by name: a method marks one entered and waits until the test opens it. */
const LATCH = `
type Latch = { readonly entered: PromiseWithResolvers<void>; readonly open: PromiseWithResolvers<void> };
const latches: Map<string, Latch> = ((globalThis as Record<string, unknown>).reloadLatches ??= new Map()) as Map<string, Latch>;
/** The latch named \`name\`, made on first use. */
function latch(name: string): Latch {
	let found = latches.get(name);
	if (found === undefined) {
		found = { entered: Promise.withResolvers(), open: Promise.withResolvers() };
		latches.set(name, found);
	}
	return found;
}
/** What the natives of every version did in this process: opens by version, closes as \`<version>:<reason>\`. */
const natives = ((globalThis as Record<string, unknown>).reloadNatives ??= { opens: [], closes: [] }) as { opens: string[]; closes: string[] };
`;

/** The counter's contract file at `version`, placed by `placement`. */
export function counterContract(placement: Placement, version: ContractVersion): string {
	const address =
		placement === "worker"
			? 'const Project = hostKind("project", { id: str() });\nconst at = ({ id }: { id: string }) => Project({ id });'
			: 'const Server = hostKind("server");\nconst at = () => Server();';
	const v1 = `export const CounterV1 = remote("reload.counter", {
	version: 1,
	params: { id: str() },
	hostAddress: at,
	variants: {
		main: {
			state: { label: str(), count: int() },
			methods: {
				add: method(int(), str()),
				slow: method(str(), str()),
				slowAdd: method(str(), str()),
				code: method(undefined, str()),
				visits: method(undefined, int()),
			},
		},
	},
});`;
	const v2 = `export const CounterV2 = evolve(CounterV1, (e) =>
	e.state("main", "label", obj({ text: str(), code: str() })).method("add", obj({ n: int() }), obj({ text: str() })),
);`;
	return [
		"// The counter's contract.",
		'import { evolve, hostKind, int, method, obj, remote, str } from "@test/app/v1";',
		address,
		v1,
		version === "v2" ? v2 : "",
		`export const Counter = ${version === "v2" ? "CounterV2" : "CounterV1"};`,
	].join("\n");
}

/** How a version of the counter's code is written. */
export type CounterCode = {
	/** What its label and `code()` say: which code answered. */
	readonly code: string;
	readonly placement: Placement;
	/** Holds a native (`self.open`): every reload of it restarts the object. */
	readonly native?: boolean;
	/** `v2` (the contract file goes with it): accepting v1 consumers through a mapping, or not. */
	readonly contract?: ContractVersion;
	readonly accepts?: boolean;
	/** A broken version: its build fails, its evaluation throws, its setup throws, or its native's open throws. */
	readonly broken?: "build" | "evaluation" | "setup" | "open";
};

/** The counter plugin's files (its contract and its server or worker facet) for `code`. */
export function counterPlugin(code: CounterCode): Record<string, string> {
	const contract = code.contract ?? "v1";
	return {
		"contract.ts": counterContract(code.placement, contract),
		[`${code.placement}.ts`]: counterFacet(code, contract),
	};
}

/**
 * The counter's facet: a store (a local object with empty params: persisted data needs a stable identity) keeping the
 * count document and the visits table, and the counter the page holds, its label naming the code.
 */
function counterFacet(code: CounterCode, contract: ContractVersion): string {
	const v = JSON.stringify(code.code);
	const label = contract === "v2" ? `({ text: \`${code.code}:\${n}\`, code: ${v} })` : `\`${code.code}:\${n}\``;
	const add =
		contract === "v2"
			? `add: async ({ n }, ctx) => ({ text: await store.add(n, ctx) }),`
			: "add: (n, ctx) => store.add(n, ctx),";
	const accepts =
		contract === "v2" && code.accepts === true
			? `, { accepts: { 1: { state: { main: { label: (current) => current.text } }, methods: { add: { args: (old) => ({ n: old }), result: (current) => current.text } } } } }`
			: "";
	const native =
		code.native === true
			? `\t\tself.open(async () => { ${code.broken === "open" ? 'throw new Error("the native does not open");' : ""} natives.opens.push(${v}); return ${v}; }, (value, reason) => { natives.closes.push(\`\${value}:\${reason.kind}\`); });`
			: "";
	return [
		`// The counter's ${code.placement} facet, code ${code.code}.`,
		'import { defineFacet, defineState, defineTable, int, local, method, obj, query, str } from "@test/app/v1";',
		'import { Counter } from "./contract.ts";',
		code.broken === "build" ? "const broken = ;" : "",
		code.broken === "evaluation" ? 'throw new Error("the counter\'s new code throws when evaluated");' : "",
		LATCH,
		'const Count = defineState("reload.count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }), persist: true, checkpointWhen: () => false });',
		'const Visits = defineTable("reload.visits", { version: 1, columns: { at: int() }, key: ["at"] });',
		'const Store = local("reload.store", { version: 1, params: {}, members: { count: int(), add: method(int(), str()), visits: method(undefined, int()) } });',
		"export default defineFacet((host) => {",
		code.broken === "setup" ? '\tthrow new Error("the counter\'s new setup throws");' : "",
		"\thost.serve(Store, (_params, self) => {",
		"\t\tconst doc = self.state(Count);",
		"\t\tconst visits = self.table(Visits);",
		"\t\treturn {",
		"\t\t\tcount: self.derive([doc], ([value]) => value.n),",
		"\t\t\tadd: async (n, ctx) => {",
		"\t\t\t\tawait doc.change((draft) => { draft.n += n; }, ctx);",
		"\t\t\t\tconst at = doc.value.n;",
		"\t\t\t\tawait self.tx(async (tx) => { tx.put(visits, { at }); }, ctx);",
		`\t\t\t\treturn \`${code.code}:\${at}\`;`,
		"\t\t\t},",
		"\t\t\tvisits: async (ctx) => visits.count(query(Visits), ctx),",
		"\t\t};",
		"\t});",
		"\thost.serve(Counter, (_params, _principal, self) => {",
		native,
		"\t\tconst store = self.get(Store, {});",
		'\t\treturn { variant: "main", members: {',
		`\t\t\tlabel: self.derive([store.count], ([n]) => ${label}),`,
		"\t\t\tcount: self.derive([store.count], ([n]) => n),",
		`\t\t\t${add}`,
		`\t\t\tslow: async (name) => { const held = latch(name); held.entered.resolve(); await held.open.promise; return \`${code.code}:\${name}\`; },`,
		"\t\t\tslowAdd: async (name, ctx) => { const held = latch(name); held.entered.resolve(); await held.open.promise; return store.add(10, ctx); },",
		`\t\t\tcode: async () => ${v},`,
		"\t\t\tvisits: (ctx) => store.visits(ctx),",
		"\t\t} };",
		`\t}${accepts});`,
		"});",
	].join("\n");
}

/** The latch plugin's worker facet: `Control` on each project's worker opens latches and reads them for the test. */
export const LATCH_PLUGIN: Readonly<Record<string, string>> = {
	"worker.ts": [
		"// The latch plugin: the test's hand on the latches and the natives' record in a worker's process.",
		'import { arr, bool, defineFacet, hostKind, method, obj, remote, str } from "@test/app/v1";',
		LATCH,
		'const Project = hostKind("project", { id: str() });',
		'const Control = remote("reload.control", { version: 1, params: { id: str() }, hostAddress: ({ id }) => Project({ id }), variants: { main: { state: {}, methods: {',
		"\tentered: method(str(), bool()), open: method(str()), natives: method(undefined, obj({ opens: arr(str()), closes: arr(str()) })),",
		"} } } });",
		'export default defineFacet((host) => host.serve(Control, () => ({ variant: "main", members: {',
		"\tentered: async (name) => { await latch(name).entered.promise; return true; },",
		"\topen: async (name) => { latch(name).open.resolve(); return null; },",
		"\tnatives: async () => ({ opens: [...natives.opens], closes: [...natives.closes] }),",
		"} })));",
	].join("\n"),
};

/** How a version of a web plugin is written. */
export type WebCode = {
	/** Its name: its section's `data-view` and its probe name. */
	readonly name: string;
	/** What its view says it is (`<name>:<code>`): which code renders. */
	readonly code: string;
	/** The counter it shows, through its own copy of the contract (an old page keeps its copy); none: no reference. */
	readonly counter?: { readonly placement: Placement; readonly contract: ContractVersion };
	/** Shows the server's summary of the counter instead (`summaryPlugin`), through its own contract copy. */
	readonly summary?: boolean;
	/** A broken version: its build fails or its evaluation throws. */
	readonly broken?: "build" | "evaluation";
	/** Contributes no view (its contributions changed shape: none now). */
	readonly hidden?: boolean;
};

/** A web plugin's files: its view (the counter's label, count and state, a draft and a kept input) and contract copy. */
export function webPlugin(code: WebCode): Record<string, string> {
	const name = JSON.stringify(code.name);
	const counter = code.counter;
	const lines = [
		`// The ${code.name} web plugin, code ${code.code}.`,
		'import { createElement as h, useEffect, useState } from "react";',
		'import { defineFacet } from "@test/app/v1";',
		'import { probe, useHold, usePageState, useRefState, useWatch, Views } from "@test/app/v1/web";',
		counter === undefined
			? ""
			: `import { ${code.summary === true ? "Summary as Counter" : "Counter"} } from "./contract.ts";`,
		code.broken === "build" ? "const broken = ;" : "",
		code.broken === "evaluation" ? 'throw new Error("the web plugin\'s new code throws when evaluated");' : "",
		counter === undefined ? "" : `probe.contracts[${name}] = Counter;`,
		"function Shown() {",
		counter === undefined
			? "\treturn null;"
			: [
					'\tconst ref = useHold(Counter, { id: "p1" });',
					"\tconst label = useWatch(ref?.label);",
					"\tconst count = useWatch(ref?.count);",
					"\tconst state = useRefState(ref);",
					`\tuseEffect(() => { if (ref !== undefined) probe.track(${name}, ref, "label"); }, [ref]);`,
					'\treturn h("span", null,',
					'\t\th("span", { className: "label" }, label === undefined ? "none" : typeof label === "string" ? label : JSON.stringify(label)),',
					'\t\th("span", { className: "count" }, String(count ?? "none")),',
					'\t\th("span", { className: "state" }, state?.kind ?? "none"),',
					"\t);",
				].join("\n"),
		"}",
		"function View() {",
		'\tconst [draft, setDraft] = useState("");',
		`\tconst [kept, setKept] = usePageState(${JSON.stringify(`${code.name}.kept`)}, "");`,
		'\treturn h("div", null,',
		`\t\th("span", { className: "code" }, ${JSON.stringify(`${code.name}:${code.code}`)}),`,
		"\t\th(Shown),",
		'\t\th("input", { className: "draft", value: draft, onChange: (event: { target: { value: string } }) => setDraft(event.target.value) }),',
		'\t\th("input", { className: "kept", value: kept, onChange: (event: { target: { value: string } }) => setKept(event.target.value) }),',
		"\t);",
		"}",
		code.hidden === true
			? "export default defineFacet(() => {});"
			: `export default defineFacet((_host, self) => self.contribute(Views, { name: ${name}, component: View }));`,
	];
	return {
		"web.ts": lines.join("\n"),
		...(counter === undefined
			? {}
			: {
					"contract.ts":
						code.summary === true ? SUMMARY_CONTRACT : counterContract(counter.placement, counter.contract),
				}),
	};
}

/** The summary's contract: on the server, its label the counter's seen through the summary's code. */
const SUMMARY_CONTRACT = `// The summary's contract.
import { hostKind, int, method, remote, str } from "@test/app/v1";
const Server = hostKind("server");
export const Summary = remote("reload.summary", {
	version: 1,
	params: { id: str() },
	hostAddress: () => Server(),
	variants: { main: { state: { label: str(), count: int() }, methods: { code: method(undefined, str()) } } },
});`;

/**
 * The summary plugin's files: a pure object on the server whose factory holds the counter of project `id` on its worker
 * (a dependency on another host), its label `<code>(<counter's count>)`. The counter's contract is the counter
 * plugin's file, imported by relative path (copied into the summary's script).
 */
export function summaryPlugin(code: string): Record<string, string> {
	return {
		"contract.ts": SUMMARY_CONTRACT,
		"server.ts": [
			`// The summary's server facet, code ${code}.`,
			'import { defineFacet } from "@test/app/v1";',
			'import { Counter } from "../counter/contract.ts";',
			'import { Summary } from "./contract.ts";',
			"export default defineFacet((host) => host.serve(Summary, ({ id }, _principal, self) => {",
			"\tconst counter = self.get(Counter, { id });",
			'\treturn { variant: "main", members: {',
			`\t\tlabel: self.derive([counter.count], ([count]) => \`${code}(\${count})\`),`,
			"\t\tcount: self.derive([counter.count], ([count]) => count),",
			`\t\tcode: async () => ${JSON.stringify(code)},`,
			"\t} };",
			"}));",
		].join("\n"),
	};
}

/** The tasks' contract: on project `id`'s worker, the finished runs' entries and how many run. */
const TASKS_CONTRACT = `// The tasks' contract.
import { arr, hostKind, int, method, remote, str } from "@test/app/v1";
const Project = hostKind("project", { id: str() });
export const Tasks = remote("reload.tasks", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Project({ id }),
	variants: { main: { state: { entries: arr(str()), running: int() }, methods: { start: method(str(), str()) } } },
});`;

/**
 * The tasks plugin's files: a runner (a local store) with an in-memory job whose run waits on the latch named by its
 * argument, and whose `finish` records `<code>-finish(<outcome>)` in a persisted list; `native`: the runner holds a
 * native, so a reload restarts it. The page reaches it through `Tasks`.
 */
export function tasksPlugin(code: string, native = false): Record<string, string> {
	const v = JSON.stringify(code);
	return {
		"contract.ts": TASKS_CONTRACT,
		"worker.ts": [
			`// The tasks' worker facet, code ${code}.`,
			'import { arr, defineFacet, defineJob, defineState, int, local, method, obj, str } from "@test/app/v1";',
			'import { Tasks } from "./contract.ts";',
			LATCH,
			'const Entries = defineState("reload.entries", { schema: obj({ list: arr(str()) }), version: 1, initial: () => ({ list: [] }), persist: true, checkpointWhen: () => false });',
			'const Task = defineJob("reload.task", { version: 1, args: obj({ name: str() }), result: str() });',
			'const Runner = local("reload.runner", { version: 1, params: {}, members: { entries: arr(str()), running: int(), start: method(str(), str()) } });',
			"export default defineFacet((host) => {",
			"\thost.serve(Runner, (_params, self) => {",
			native ? `\t\tself.open(async () => ${v}, () => {});` : "",
			"\t\tconst entries = self.state(Entries);",
			"\t\tconst task = self.job(Task, {",
			"\t\t\trun: async ({ name }, ctx) => {",
			"\t\t\t\tconst held = latch(name);",
			"\t\t\t\theld.entered.resolve();",
			"\t\t\t\tawait new Promise<void>((resolve, reject) => {",
			"\t\t\t\t\tvoid held.open.promise.then(resolve);",
			'\t\t\t\t\tctx.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));',
			"\t\t\t\t});",
			`\t\t\t\treturn \`run-${code}:\${name}\`;`,
			"\t\t\t},",
			"\t\t\tfinish: async (outcome, tx) => {",
			'\t\t\t\tconst what = outcome.kind === "done" ? "done:" + outcome.result : outcome.error.kind === "aborted" ? "aborted:" + outcome.error.reason : outcome.error.kind;',
			`\t\t\t\t(await tx.draft(entries)).list.push(\`${code}-finish(\${what})\`);`,
			"\t\t\t},",
			"\t\t});",
			"\t\treturn {",
			"\t\t\tentries: self.derive([entries], ([value]) => value.list),",
			"\t\t\trunning: self.derive([task.running], ([running]) => running.length),",
			"\t\t\tstart: async (name, ctx) => (await task.start({ name }, ctx)).id,",
			"\t\t};",
			"\t});",
			"\thost.serve(Tasks, (_params, _principal, self) => {",
			"\t\tconst runner = self.get(Runner, {});",
			'\t\treturn { variant: "main", members: { entries: runner.entries, running: runner.running, start: (name, ctx) => runner.start(name, ctx) } };',
			"\t});",
			"});",
		].join("\n"),
		"web.ts": [
			"// The tasks' web facet: registers the contract for the page's probe.",
			'import { defineFacet } from "@test/app/v1";',
			'import { probe } from "@test/app/v1/web";',
			'import { Tasks } from "./contract.ts";',
			"probe.contracts.tasks = Tasks;",
			"export default defineFacet(() => {});",
		].join("\n"),
	};
}
