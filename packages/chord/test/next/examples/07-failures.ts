// Failures: how an activation fails (transient or broken), how Chord retries it, and what getters see.
// Run from packages/chord (takes about 3 s: the retries wait 1 s, then 2 s):
//   node --conditions=source --experimental-strip-types test/next/examples/07-failures.ts
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
import { int, local, str } from "../../../src/next/contracts/index.ts";
import { broken, isChordError } from "../../../src/next/data/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";

const context = BACKGROUND_CONTEXT;
const start = Date.now();
const at = (): string => `${((Date.now() - start) / 1000).toFixed(1)} s`;

// A connection to a remote service, which is down for the first two attempts.
const Remote = local("example.remote", { version: 1, params: {}, members: { status: str() } });
// An inbox per user, which needs the connection.
const Inbox = local("example.inbox", { version: 1, params: { user: str() }, members: { status: str() } });
// A mirror whose configuration is missing: retrying cannot help.
const Mirror = local("example.mirror", { version: 1, params: { id: int() }, members: { status: str() } });
// A service whose open never finishes.
const Stuck = local("example.stuck", { version: 1, params: { id: int() }, members: { status: str() } });

let attempts = 0;
const facet = defineFacet((host) => {
	host.serve(Remote, (_, self) => {
		const attempt = ++attempts;
		self.open(
			async () => {
				console.log(`${at()}: remote, attempt ${attempt}`);
				// A throwing open is transient: Chord retries it after 1 s, then 2 s, 4 s, ... up to 60 s.
				if (attempt <= 2) throw new Error("connection refused");
				return { connected: true };
			},
			() => {},
		);
		return { status: constant("connected") };
	});
	host.serve(Inbox, ({ user }, self) => {
		// A dependency that fails fails this object transient too; it is retried the moment the dependency is live.
		const remote = self.get(Remote, {});
		console.log(`${at()}: inbox ${user}, attempt`);
		return { status: self.derive([remote.status], ([status]) => `${user}: ${status}`) };
	});
	host.serve(Mirror, (_, self) => {
		self.open(
			async () => {
				// broken(error) says retrying is pointless: no retry, and getters are rejected at once.
				throw broken(new Error("no mirror configured"));
			},
			() => {},
		);
		return { status: constant("mirroring") };
	});
	host.serve(Stuck, (_, self) => {
		self.open(
			() => new Promise(() => {}),
			() => {},
		);
		return { status: constant("never") };
	});
});

// Every failed attempt is reported, with its object and cause.
const onError = (error: HostError): void => {
	if (error.kind === "activation_failed") {
		console.log(`${at()}: reported ${error.object}, ${error.failure.kind}: ${error.failure.error.message}`);
	}
};

/** Prints how a get ended. */
async function attempt(label: string, work: () => Promise<{ status: { value: string } }>): Promise<void> {
	try {
		const reference = await work();
		console.log(`${at()}: ${label}: ${reference.status.value}`);
	} catch (error) {
		if (isChordError(error)) console.log(`${at()}: ${label}: ${error.code} - ${error.message}`);
	}
}

// Every attempt must be live within readyTimeout (here 500 ms); getters wait up to it too, unless they say otherwise.
const host = createHost({ onError, readyTimeout: 500 });
// The start barrier: load resolves once the remote (empty params: it lives as long as the host) had its first outcome.
await host.load([{ name: "@example/failures", facet }], context);
console.log(`${at()}: loaded`);

// A broken failure rejects the get at once.
await attempt("mirror", () => host.get(Mirror, { id: 1 }, context));

// An attempt not live within readyTimeout is abandoned and fails transient; this get waits longer (700 ms) and then
// rejects with the last failure's error.
await attempt("stuck", () => host.get(Stuck, { id: 1 }, context, { readyTimeout: 700 }));

// Transient failures keep a get waiting through the retries, up to its deadline: the inbox goes live with the remote.
await attempt("inbox", () => host.get(Inbox, { user: "mario" }, context, { readyTimeout: 10_000 }));

await host.close(context);
