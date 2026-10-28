import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	createHost,
	defineRegistry,
	type FacetApi,
	forbidden,
	hostNamed,
	isChordError,
	local,
	memoryLinkPair,
	remote,
} from "../src/index.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const unexpectedError = (error: unknown) => assert.fail(String(error));
const Eager = local("ready.eager", { version: 1, input: Type.Object({}) });
const Lazy = local("ready.lazy", { version: 1, input: Type.Object({}) });

// Startup must not report ready while an eager object has failed.
describe("host: eager readiness", () => {
	for (const operation of ["install", "load"] as const) {
		it(`${operation} awaits resource activation and registration, leaving lazy objects lazy`, async () => {
			const host = createHost({ self: { kind: "host" }, onError: unexpectedError });
			const entries = defineRegistry<string>("ready.entries");
			let opened = () => {};
			let lazyRuns = 0;
			let settled = false;
			const facet = {
				name: "ready",
				setup({ serve }: FacetApi) {
					serve(
						Eager,
						(_input, _principal, self) => {
							self.resource("r", {
								version: 1,
								open: () =>
									new Promise<void>((resolve) => {
										opened = resolve;
									}),
							});
							self.register(entries, { eager: "live" });
							return {};
						},
						{ lifetime: "host" },
					);
					serve(Lazy, () => {
						lazyRuns++;
						return {};
					});
				},
			};
			try {
				const loading = operation === "install" ? host.install(facet) : host.load([facet]);
				void loading.then(() => {
					settled = true;
				});
				await tick();
				assert.equal(settled, false);
				assert.equal(host.registry(entries).get("eager"), undefined);
				opened();
				await loading;
				assert.equal(host.registry(entries).get("eager"), "live");
				assert.equal(lazyRuns, 0);
			} finally {
				await host.close();
			}
		});

		for (const failure of ["factory", "dependency", "resource"] as const) {
			it(`${operation} rejects eager ${failure} failure with the activation error`, async () => {
				const errors: unknown[] = [];
				const host = createHost({ self: { kind: "host" }, onError: (error) => errors.push(error) });
				const cause = forbidden(`${failure} failed`);
				const facet = {
					name: "bad",
					setup({ serve }: FacetApi) {
						serve(Lazy, () => {
							throw cause;
						});
						serve(
							Eager,
							(_input, _principal, self) => {
								if (failure === "factory") throw cause;
								if (failure === "dependency") self.get(Lazy, {});
								if (failure === "resource")
									self.resource("r", {
										version: 1,
										open: () => {
											throw cause;
										},
									});
								return {};
							},
							{ lifetime: "host" },
						);
					},
				};
				try {
					await assert.rejects(
						operation === "install" ? host.install(facet) : host.load([facet]),
						(error) => error === cause,
					);
					await assert.rejects(host.ready(), (error) => error === cause);
					assert.deepEqual(errors, [cause]);
				} finally {
					await host.close();
				}
			});
		}
	}

	it("load installs every facet before awaiting eager consumers", async () => {
		const host = createHost({ self: { kind: "host" }, onError: unexpectedError });
		try {
			await host.load([
				{
					name: "consumer",
					setup: ({ serve }) =>
						serve(
							Eager,
							(_input, _principal, self) => {
								self.get(Lazy, {});
								return {};
							},
							{ lifetime: "host" },
						),
				},
				{ name: "provider", setup: ({ serve }) => serve(Lazy, () => ({})) },
			]);
			assert.equal(host.hold(Eager, {}).status, "live");
		} finally {
			await host.close();
		}
	});

	it("missing eager dependencies reject load instead of only reaching onError", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		try {
			await assert.rejects(
				host.load([
					{
						name: "missing",
						setup: ({ serve }) =>
							serve(
								Eager,
								(_i, _p, self) => {
									self.get(Lazy, {});
									return {};
								},
								{ lifetime: "host" },
							),
					},
				]),
				(error) => isChordError(error, "unavailable") && error.reason === "unknown_type",
			);
		} finally {
			await host.close();
		}
	});

	it("ready includes direct host serves, but not later serves", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		const First = local("ready.first", { version: 1, input: Type.Object({}) });
		let created = 0;
		try {
			host.serve(
				First,
				() => {
					created++;
					return {};
				},
				{ lifetime: "host" },
			);
			const first = host.ready();
			host.serve(
				Eager,
				() => {
					throw forbidden("later");
				},
				{ lifetime: "host" },
			);
			await first;
			assert.equal(created, 1);
			await assert.rejects(host.ready(), /later/);
		} finally {
			await host.close();
		}
	});

	for (const operation of ["install", "load"] as const) {
		it(`${operation} can defer eager readiness until the parent admits the worker`, { timeout: 2000 }, async () => {
			const server = createHost({ self: { kind: "host" }, name: "server", onError: unexpectedError });
			const [parent, upstream] = memoryLinkPair();
			const worker = createHost({
				self: { kind: "host" },
				name: "worker",
				upstream: { link: upstream, principal: { kind: "server" } },
				onError: unexpectedError,
			});
			const Status = remote("ready.status", {
				version: 1,
				input: Type.Object({}),
				host: hostNamed("server"),
				variants: { default: {} },
			});
			server.serve(Status, () => ({ variant: "default" }));
			let bootstrap = false;
			let reported = false;
			const facet = {
				name: "worker",
				setup({ serve }: FacetApi) {
					serve(
						Lazy,
						() => {
							bootstrap = true;
							return {};
						},
						{ lifetime: "host" },
					);
					serve(
						Eager,
						(_input, _principal, self) => {
							const status = self.get(Status, {});
							self.resource("r", {
								version: 1,
								deps: [status],
								open: () => {
									reported = true;
								},
							});
							return {};
						},
						{ lifetime: "host" },
					);
				},
			};
			try {
				await (operation === "install"
					? worker.install(facet, { awaitHostObjects: false })
					: worker.load([facet], { awaitHostObjects: false }));
				await worker.hold(Lazy, {}).ready;
				assert.equal(bootstrap, true);
				let settled = false;
				const ready = worker.ready().then(() => {
					settled = true;
				});
				await tick();
				assert.equal(settled, false);
				assert.equal(reported, false);
				// Control-ready announcement allows the parent to accept the queued upstream holds.
				server.accept(parent, { kind: "host", name: "worker", principal: { host: "worker" } });
				await ready;
				assert.equal(reported, true);
			} finally {
				await worker.close();
				await server.close();
			}
		});
	}
});
