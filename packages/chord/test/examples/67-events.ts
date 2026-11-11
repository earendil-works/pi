// Events: fire-and-forget members (decision "Events: fire-and-forget members"). A ticking server object emits a
// paddle sample every 10 ms and commits its tick count every 100 ms; two clients hold it over links and subscribe. An
// event goes once to each reference bound before the emit, after the state published before it, never folded, never
// kept: the fast client gets every sample; the slow one (its link delivers 100 ms late) fills its event window and the
// server drops what would wait for it (nothing queues for a slow consumer), while its state still arrives whole.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/67-events.ts
import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT } from "../../src/context/index.ts";
import { event, hostKind, int, local, num, obj, remote } from "../../src/contracts/index.ts";
import { defineState } from "../../src/documents/index.ts";
import { createHost, defineFacet, type Host, sleep } from "../../src/host/index.ts";
import { type Link, memoryLinkPair } from "../../src/link/index.ts";

const context = BACKGROUND_CONTEXT;

type P = { kind: "owner" } | { kind: "server" };

const Server = hostKind("server");

/** A paddle sample: `t` the sender's sample time, `y` the position. */
const Sample = obj({ t: num(), y: num() });

/** The server's clock: its tick count (state) and its paddle (an event member, the local marker `event(...)`). */
const Clock = local("example.clock", { version: 1, params: {}, members: { tick: int(), paddle: event(Sample) } });

/** What a client holds: the clock's tick and paddle, re-exposed (an event member forwarded unchanged). */
const Game = remote("example.game", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { player: { state: { tick: int() }, events: { paddle: Sample } } },
});

const Ticks = defineState("ticks", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

const serverFacet = defineFacet<P>((host) => {
	host.serve(Clock, (_, self) => {
		const ticks = self.state(Ticks);
		const paddle = self.events<{ t: number; y: number }>();
		// The ticking: a routine emits a sample every 10 ms; every tenth also commits the tick (emit is no transaction work:
		// commit first, then emit).
		self.onLive(async (ctx) => {
			for (let index = 1; ; index++) {
				await sleep(10, ctx);
				if (index % 10 === 0) await ticks.change((draft) => void draft.n++, ctx);
				paddle.emit({ t: Date.now(), y: Math.round(Math.sin(index / 10) * 100) / 100 });
			}
		});
		return { tick: self.derive([ticks], ([value]) => value.n), paddle };
	});
	host.serve(Game, (_params, _principal, self) => {
		const clock = self.get(Clock, {});
		return { variant: "player", members: { tick: clock.tick, paddle: clock.paddle } };
	});
});

/** `link` with every message it receives delivered `ms` late, in order (a slow consumer behind a slow network). */
function late(link: Link, ms: number): Link {
	return {
		send: (message) => link.send(message),
		onMessage: (listener) => link.onMessage((message) => void setTimeout(() => listener(message), ms)),
		close: () => link.close(),
		onClose: (listener) => link.onClose(listener),
	};
}

/** A client connected to `server` (its end delivering `delay` ms late when given), counting what it receives. */
async function client(server: Host<P>, delay: number | undefined) {
	const host = createHost<P>({ onError: console.error });
	await host.load([], context);
	const [a, b] = memoryLinkPair();
	server.accept(a, { principal: { kind: "owner" } }, context);
	host.connect(delay === undefined ? b : late(b, delay), { principal: { kind: "server" } }, context);
	const game = await host.get(Game, {}, context);
	const seen = { samples: 0, lastY: 0, lag: 0 };
	// 1. Subscribe: from now on every sample delivered to this reference calls the listener (`at`: the emit's time).
	await game.paddle.on(({ value, at }) => {
		seen.samples++;
		seen.lastY = value.y;
		seen.lag = Date.now() - at;
	}, context);
	return { game, seen };
}

// 2. The server: at most 4 of its own event messages unacknowledged per link (`eventWindow`), its counters recorded.
const telemetry = new InMemoryTelemetryContext();
const server = createHost<P>({
	address: Server(),
	principal: { kind: "server" },
	eventWindow: 4,
	telemetry,
	onError: console.error,
});
await server.load([{ name: "@example/server", facet: serverFacet }], context);

// 3. Two clients: one fast, one whose link delivers 100 ms late.
const fast = await client(server, undefined);
const slow = await client(server, 100);
await sleep(1_000, context);

// 4. The fast client got about a sample per 10 ms; the slow one far fewer (dropped at the server, never queued), yet
//    its state (the tick) is current within its delay.
console.log("fast:", fast.seen, "tick", fast.game.tick.value);
console.log("slow:", slow.seen, "tick", slow.game.tick.value);
const counts: Record<string, number> = {};
for (const { name, value, attributes } of telemetry.getMetrics()) {
	if (!name.startsWith("chord.events.")) continue;
	const key = attributes?.reason === undefined ? name : `${name} (${String(attributes.reason)})`;
	counts[key] = (counts[key] ?? 0) + value;
}
console.log("server:", counts);
await server.close(context);
process.exit(0);
