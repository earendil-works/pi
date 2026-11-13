// Remote references sharing one wire hold (decision "References share one wire hold"). A page shows one remote
// counter in three components; each takes its own reference, as a component does. The page's host holds the counter
// once: one `hold` message, one snapshot, one encode per commit at the server; the second and third references join
// the held object at once, with no message. Each reference keeps its own release: releasing two sends nothing, the
// last sends the one `release`, and a reference made after it holds anew.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/68-shared-holds.ts
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { hostKind, int, method, obj, remote } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Reference } from "../../src/host/index.ts";
import { binaryCodec, type Link, memoryLinkPair } from "../../src/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" };

const Server = hostKind("server");

/** A counter on the server: its count, and a method that adds one. */
const Counter = remote("example.shared-counter", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { v: { state: { count: int() }, methods: { bump: method() } } },
});

const Count = defineState("count", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

/** `link` with the kinds of the messages it sends counted in `sent` (decoded: the binary codec is the wire's). */
function counted(link: Link, sent: Map<string, number>): Link {
	return {
		send: (message) => {
			const { kind } = binaryCodec.decode(message) as { kind: string };
			sent.set(kind, (sent.get(kind) ?? 0) + 1);
			link.send(message);
		},
		onMessage: (listener) => link.onMessage(listener),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

// 1. The server serves the counter; its adapter counts the encodes of its link's commits.
const telemetry = new InMemoryTelemetryContext();
const server = createHost<P>({ address: Server(), principal: { kind: "server" }, telemetry, onError: console.error });
await server.load(
	[
		{
			name: "@example/counter",
			facet: defineFacet<P>((host) =>
				host.serve(Counter, (_, _principal, self) => {
					const count = self.state(Count);
					return {
						variant: "v",
						members: {
							count: self.derive([count], ([doc]) => doc.n),
							bump: async (ctx) => {
								await count.change((draft) => void draft.n++, ctx);
								return null;
							},
						},
					};
				}),
			),
		},
	],
	context,
);

// 2. The page: its link to the server counts what the page sends.
const page = createHost<P>({ onError: console.error });
await page.load([], context);
const sent = new Map<string, number>();
const [near, far] = memoryLinkPair();
server.accept(far, { principal: { kind: "owner" }, codec: binaryCodec }, context);
page.connect(counted(near, sent), { principal: { kind: "server" }, codec: binaryCodec }, context);

// 3. Three components, three references: the first holds and waits for the snapshot; the others join at once.
const components: Reference<typeof Counter>[] = [];
for (let n = 0; n < 3; n++) components.push(await page.get(Counter, {}, context));
console.log("holds sent:", sent.get("hold"), "| server's references:", server.activity.value.references);

// 4. A commit at the server is encoded once (not once per reference) and reaches every component in one batch.
const encodes = (): number =>
	telemetry
		.getMetrics()
		.filter(({ name }) => name === "chord.link.encodes")
		.reduce((sum, { value }) => sum + value, 0);
const before = encodes();
const first = components[0] as Extract<Reference<typeof Counter>, { readonly variant: "v" }>;
await first.bump(context);
await new Promise((resolve) => setTimeout(resolve, 10));
const counts = components.map((component) => (component as typeof first).count.value);
console.log("counts:", counts, "| encodes for the commit:", encodes() - before);

// 5. Releasing two sends nothing; the last sends the one release; a reference made after it holds anew.
components[0]!.release();
components[1]!.release();
console.log("releases after two:", sent.get("release") ?? 0);
components[2]!.release();
await page.get(Counter, {}, context);
console.log("releases after three:", sent.get("release"), "| holds sent:", sent.get("hold"));
await page.close(context);
await server.close(context);
process.exit(0);
