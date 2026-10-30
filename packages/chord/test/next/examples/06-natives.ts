// Natives: values an object opens during activation and closes when it ends (a file watcher, a connection, a timer).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/next/examples/06-natives.ts
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, method, str } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;

const Clock = local("example.clock", {
	version: 1,
	params: { zone: str() },
	members: { zone: str(), now: method(undefined, str()) },
});
const Leaky = local("example.leaky", { version: 1, params: {}, members: { n: int() } });

const facet = defineFacet((host) => {
	host.serve(Clock, ({ zone }, self) => {
		// `self.open(open, close)` declares a native; it opens after the references are live, in declaration order.
		const config = self.open(
			async () => {
				console.log(`${zone}: open config`);
				return { prefix: `[${zone}]` };
			},
			(_config, reason) => console.log(`${zone}: close config (${reason.kind})`),
		);
		// A later opener reads an earlier native's value. Its context is aborted if the object ends while it opens.
		const ticker = self.open(
			async () => {
				console.log(`${zone}: open ticker, config ${config.value.prefix}`);
				const ticker = { ticks: 0, timer: setInterval(() => ticker.ticks++, 10) };
				return ticker;
			},
			(ticker, reason) => {
				clearInterval(ticker.timer);
				console.log(`${zone}: close ticker (${reason.kind})`);
			},
		);
		// The factory only declares: a value is there once its open resolved.
		try {
			config.value;
		} catch (error) {
			if (isChordError(error, "not_ready")) console.log(`${zone}: in the factory, ${error.message}`);
		}
		return {
			zone: constant(zone),
			now: async () => `${config.value.prefix} ${ticker.value.ticks > 0 ? "ticking" : "starting"}`,
		};
	});
	// Closes that throw or hang: they never stop the other closes.
	host.serve(Leaky, (_, self) => {
		self.open(
			async () => "socket",
			() => {
				throw new Error("socket close failed");
			},
		);
		self.open(
			async () => "worker",
			() => new Promise<void>(() => {}),
			{ closeTimeout: 50 },
		);
		return { n: constant(1) };
	});
});

// onError gets what fails in the background: here a close past its closeTimeout.
const host = createHost({
	onError: (error) => console.log("reported:", error.kind, "object" in error ? error.object : ""),
});
await host.load([{ name: "@example/natives", facet }], context);

const vienna = await host.get(Clock, { zone: "vienna" }, context);
console.log("now:", await vienna.now(context));
await sleep(30);
console.log("now:", await vienna.now(context));

// The last reference gone, the object ends: natives close in reverse order, with reason `end`.
vienna.release();
await sleep(0);

// host.close ends every object at once and closes their natives with reason `close`; it rejects with every close
// that threw.
await host.get(Clock, { zone: "tokyo" }, context);
try {
	await host.close(context);
} catch (error) {
	if (error instanceof AggregateError)
		console.log(
			"host.close:",
			error.errors.map((e: Error) => e.message),
		);
}
