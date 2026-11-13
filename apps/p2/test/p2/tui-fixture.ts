// The deployed TUI topology for tests: a "server" host, a "session:s" worker host below it (reached through the
// server's route, as the sessions plugin's), and the TUI's client host above it running a TuiRuntime with the given
// TUI facets on a virtual terminal.

import { TuiAltScreen } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { type Session, Sessions } from "../../plugins/sessions/contract.ts";
import { type defineFacet, Session as SessionHost } from "../../src/runtime/chord.ts";
import { SERVER } from "../../src/runtime/principals.ts";
import { TuiRuntime } from "../../src/runtime/tui.ts";
import { tuiCoreFacet } from "../../src/tui/core-commands.ts";
import { memoryLinkPair, testHost } from "./helpers.ts";

export type Stub = Parameters<typeof testHost>[0]["stubs"] extends readonly (infer S)[] | undefined ? S : never;

export const SESSION: Session = {
	id: "s",
	cwd: "/work",
	title: "Fixture",
	createdAt: 1,
	updatedAt: 1,
	archivedAt: null,
	pinned: false,
	model: { provider: "faux", modelId: "faux-1" },
	thinkingLevel: "off",
	main: 1,
	branches: [],
};
export const sessionsStub = (session: Session): Stub => [
	Sessions,
	(_input, _principal, self) => ({
		variant: "guest",
		sessions: self.state([session]),
	}),
];

/**
 * The deployed topology: a "server" host, a "session:s" worker host below it, and the TUI's client host above it
 * running the runtime with TUI facets on a virtual terminal.
 */
export async function topology(
	t: { after(fn: () => unknown): void },
	options: {
		server: Stub[];
		worker: Stub[];
		facets: ReturnType<typeof defineFacet>[];
		role?: "owner" | "guest";
		columns?: number;
		/** The worker host becomes reachable only when this resolves (a starting worker, a reconnect). */
		ready?: Promise<void>;
	},
) {
	const owner = { kind: "owner", access: "local" } as const;
	const worker = await testHost({
		address: SessionHost({ id: "s" }),
		kind: "worker",
		facets: [],
		stubs: options.worker,
	});
	t.after(() => worker.close());
	// The server's route to the worker host (spawned on first use, as the session workers' route does).
	let link: ReturnType<typeof memoryLinkPair>[0] | undefined;
	const server = await testHost({
		facets: [],
		stubs: options.server,
		principal: owner,
		beforeLoad: (host) =>
			host.route(
				SessionHost,
				{
					authorize: () => true,
					resolve: async (address) => {
						// One worker host: other sessions (a new one the TUI opens) have none to reach.
						if (address.params.id !== "s") throw new Error(`no worker for ${address.key}`);
						await options.ready;
						if (!link) {
							const [down, up] = memoryLinkPair();
							worker.host.connect(up, { principal: SERVER }, BACKGROUND_CONTEXT);
							link = down;
						}
						return { link, principal: { kind: "worker", session: "s", generation: 1 } };
					},
				},
				BACKGROUND_CONTEXT,
			),
	});
	t.after(() => server.close());
	// The core facet serves the TUI's registries: added unless the test brings it.
	const facets = options.facets.includes(tuiCoreFacet) ? options.facets : [tuiCoreFacet, ...options.facets];
	const plugins = (list: readonly ReturnType<typeof defineFacet>[]) =>
		list.map((facet, index) => ({ name: `tui-${index}`, facet }));
	const client = await server.clientWith(owner, plugins(facets));
	/** Reloads the TUI host with `next` in place of the facets (the core added as at the start). */
	const reload = async (next: ReturnType<typeof defineFacet>[]) => {
		await client.reload(plugins(next.includes(tuiCoreFacet) ? next : [tuiCoreFacet, ...next]), BACKGROUND_CONTEXT);
	};
	const terminal = new VirtualTerminal(options.columns ?? 80, 24);
	const tui = new TuiAltScreen(terminal);
	const runtime = new TuiRuntime(client, tui);
	runtime.connected = true;
	runtime.role = options.role ?? "owner";
	runtime.session = "s";
	runtime.screen = "chat";
	await runtime.start();
	tui.setLayoutRoot(runtime.root);
	tui.setFocus(runtime);
	tui.start();
	t.after(() => {
		tui.stop();
		runtime.dispose();
	});
	const screen = async () =>
		(await terminal.flushAndGetViewport()).map((line) => line.replace(/[│┃]$/, "")).join("\n");
	return {
		client,
		server,
		worker,
		runtime,
		tui,
		terminal,
		screen,
		reload,
		send: (data: string) => terminal.sendInput(data),
	};
}
