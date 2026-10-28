// Entry 8: a local object goes live only with its state, also where it forwards or derives from a remote reference's
// member; activation waits at most `readyTimeout` (a cycle across hosts fails with a hint instead of hanging).
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	type Host,
	hostNamed,
	isChordError,
	local,
	memoryLinkPair,
	method,
	remote,
} from "../src/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lives on the worker `w`; its value is set by `set`. */
const Source = remote("t.e8-source", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("w"),
	variants: { main: { state: { v: Type.String() }, methods: { set: method(Type.String()) } } },
});

/** Lives on the server; forwards (and derives from) the worker's `Source`. */
const Forward = remote("t.e8-forward", {
	version: 1,
	input: Type.Object({ how: Type.String() }),
	host: hostNamed("server"),
	variants: { main: { state: { v: Type.String(), size: Type.Number() } } },
});

function serveSource(host: Host): void {
	host.serve(Source, (_input, _principal, self) => {
		const v = self.state("v", Type.String(), "from the worker");
		return {
			variant: "main",
			v,
			set: (text: string, ctx: Ctx) => {
				v.replace(ctx, text);
			},
		};
	});
}

/** A server with a worker child `w` (accepted after `delay` ms, as p2's server admits a worker after it is ready). */
function cluster(options: { readonly delay?: number; readonly readyTimeout?: number } = {}) {
	const server = createHost({
		self: { kind: "host" },
		name: "server",
		onError: () => {},
		...(options.readyTimeout === undefined ? {} : { readyTimeout: options.readyTimeout }),
	});
	const [down, up] = memoryLinkPair();
	const worker = createHost({
		self: { kind: "host" },
		name: "w",
		upstream: { link: up, principal: { kind: "server" } },
		onError: () => {},
		...(options.readyTimeout === undefined ? {} : { readyTimeout: options.readyTimeout }),
	});
	const admit = () => server.accept(down, { principal: { kind: "worker" }, kind: "host", name: "w" });
	if (options.delay === undefined) admit();
	else setTimeout(admit, options.delay);
	const browser = () => {
		const [down2, up2] = memoryLinkPair();
		server.accept(down2, { principal: { user: "u" } });
		return createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up2, principal: { kind: "server" } },
			onError: () => {},
		});
	};
	return { server, worker, browser };
}

describe("local hydration", () => {
	it("an object that forwards and derives from a remote member goes live with its value", async () => {
		const c = cluster();
		serveSource(c.worker);
		// Held outside the factory (no `self.get`): activation still waits for its snapshot.
		const held = c.server.hold(Source, {});
		c.server.serve(Forward, ({ how }, _principal, self) => {
			const source = how === "declared" ? self.get(Source, {}) : held;
			return { variant: "main", v: source.v, size: self.derive([source.v], (text) => text.length) };
		});
		const browser = c.browser();
		for (const how of ["held", "declared"]) {
			const forward = browser.hold(Forward, { how });
			await forward.ready;
			assert.equal(forward.v.value, "from the worker");
			assert.equal(forward.size.value, "from the worker".length);
			const local = c.server.hold(Forward, { how });
			await local.ready;
			assert.equal(local.v.value, "from the worker");
		}
		await c.server.close();
		await c.worker.close();
	});

	it("a member read inside a factory throws not_ready; it is a plain value once live", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const Inner = local("t.e8-inner", { version: 1, input: Type.Object({}), members: { n: Type.Number() } });
		const Outer = local("t.e8-outer", { version: 1, input: Type.Object({}), members: { m: Type.Number() } });
		host.serve(Inner, (_input, _principal, self) => ({ n: self.state("n", Type.Number(), 7) }));
		const seen: unknown[] = [];
		host.serve(Outer, (_input, _principal, self) => {
			const inner = self.get(Inner, {});
			try {
				seen.push(inner.n.value);
			} catch (error) {
				seen.push(isChordError(error, "not_ready") ? "not_ready" : error);
			}
			return { m: self.derive([inner.n], (n) => n * 2) };
		});
		const outer = host.hold(Outer, {});
		await outer.ready;
		assert.deepEqual(seen, ["not_ready"]);
		assert.equal(outer.m.value, 14);
	});

	it("a host object of a child holding the parent's object goes live once the parent admits the child", async () => {
		const Settings = remote("t.e8-settings", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { state: { theme: Type.String() } } },
		});
		const Local = local("t.e8-boot", { version: 1, input: Type.Object({}), members: { theme: Type.String() } });
		const c = cluster({ delay: 20 });
		c.server.serve(Settings, (_input, _principal, self) => ({
			variant: "main",
			theme: self.state("theme", Type.String(), "dark"),
		}));
		await c.worker.install(
			{
				name: "boot",
				setup: (api) =>
					api.serve(
						Local,
						(_input, _principal, self) => {
							const settings = self.get(Settings, {});
							return { theme: settings.theme };
						},
						{ lifetime: "host" },
					),
			},
			{ awaitHostObjects: false },
		);
		await c.worker.ready();
		const boot = c.worker.hold(Local, {});
		await boot.ready;
		assert.equal(boot.theme.value, "dark");
		await c.server.close();
		await c.worker.close();
	});

	it("a reference cycle across hosts fails at readyTimeout with a cycle hint", async () => {
		const A = remote("t.e8-cycle-a", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: {} },
		});
		const B = remote("t.e8-cycle-b", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("w"),
			variants: { main: {} },
		});
		const c = cluster({ readyTimeout: 50 });
		c.server.serve(A, (_input, _principal, self) => {
			self.get(B, {});
			return { variant: "main" };
		});
		c.worker.serve(B, (_input, _principal, self) => {
			self.get(A, {});
			return { variant: "main" };
		});
		const a = c.server.hold(A, {});
		await assert.rejects(
			a.ready,
			(error) =>
				isChordError(error, "unavailable") && error.reason === "ready_timeout" && /cycle/.test(error.message),
		);
		await sleep(10);
		await c.server.close();
		await c.worker.close();
	});
});
