import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { int, local } from "../../../src/next/contracts/index.ts";
import { isChordError } from "../../../src/next/data/index.ts";
import type { FacetHost, Native } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { failures, fakeTimers, flushed, loaded, rejection } from "../support.ts";

const Res = local("app.res", { version: 1, params: { id: int() }, members: { n: int() } });

describe("opening", () => {
	it("opens one after another in declaration order; a later opener reads an earlier handle", async () => {
		const events: string[] = [];
		const first = Promise.withResolvers<string>();
		const { host } = await loaded((h) =>
			h.serve(Res, (_, self) => {
				const a = self.open(
					async () => {
						events.push("open a");
						return first.promise;
					},
					() => {},
				);
				self.open(
					async () => {
						events.push(`open b with ${a.value}`);
						return "b";
					},
					() => {},
				);
				return { n: constant(1) };
			}),
		);
		const got = host.get(Res, { id: 1 }, context);
		await flushed();
		expect(events).toEqual(["open a"]);
		first.resolve("a");
		await got;
		expect(events).toEqual(["open a", "open b with a"]);
	});

	it("opens nothing for an object ended before its first open started", async () => {
		const opens = vi.fn(async () => null);
		const { host } = await loaded((h) =>
			h.serve(Res, (_, self) => {
				self.open(opens, () => {});
				return { n: constant(1) };
			}),
		);
		host.hold(Res, { id: 1 }, context).release();
		await flushed();
		expect(opens).not.toHaveBeenCalled();
	});

	it("throws not_ready before its open resolved and released once its close started", async () => {
		const reads: unknown[] = [];
		const read = (native: Native<string>): void => {
			try {
				reads.push(native.value);
			} catch (error) {
				reads.push(isChordError(error) ? error.toJSON() : error);
			}
		};
		const { host } = await loaded((h) =>
			h.serve(Res, (_, self) => {
				const a: Native<string> = self.open(
					async () => {
						read(b);
						return "a";
					},
					() => read(a),
				);
				const b: Native<string> = self.open(
					async () => "b",
					() => read(a),
				);
				read(a);
				return { n: constant(1) };
			}),
		);
		(await host.get(Res, { id: 1 }, context)).release();
		await flushed();
		expect(reads).toEqual([
			// In the factory, and b in a's opener.
			{ code: "not_ready", message: "app.res(1) native #1: not open yet" },
			{ code: "not_ready", message: "app.res(1) native #2: not open yet" },
			// a in b's close (b closes first), then in a's own close.
			"a",
			{ code: "released", reason: "closed", message: "app.res(1) native #1: closed" },
		]);
	});

	it("a partly failed attempt closes what it opened, with reason end", async () => {
		const closes: string[] = [];
		const { host, errors } = await loaded((h) =>
			h.serve(Res, (_, self) => {
				self.open(
					async () => "a",
					(value, reason) => void closes.push(`${value} ${reason.kind}`),
				);
				self.open(
					async () => {
						throw new Error("offline");
					},
					() => void closes.push("b"),
				);
				return { n: constant(1) };
			}),
		);
		expect(await rejection(host.get(Res, { id: 1 }, context, { readyTimeout: 10 }))).toEqual({
			code: "unavailable",
			message: "app.res(1): offline",
		});
		expect(closes).toEqual(["a end"]);
		expect(failures(errors)).toEqual(["app.res(1): transient"]);
		await host.close(context);
	});

	it.each(["end", "close"])(
		"aborts the opener's context when the object ends while opening; a late value is closed once (%s)",
		async (reason) => {
			const opener = Promise.withResolvers<Context>();
			const late = Promise.withResolvers<string>();
			const closes: unknown[] = [];
			const { host } = await loaded((h) =>
				h.serve(Res, (_, self) => {
					self.open(
						async (ctx) => {
							opener.resolve(ctx);
							return late.promise;
						},
						// The close runs under the object's context, not under the opener's aborted one.
						(value, reason, ctx) => void closes.push([value, reason.kind, ctx.abortSignal?.aborted]),
					);
					return { n: constant(1) };
				}),
			);
			const { context: cancellable, cancel } = withCancel(context);
			const got = host.get(Res, { id: 1 }, cancellable);
			const openContext = await opener.promise;
			if (reason === "end") cancel(new Error("left"));
			else await host.close(context);
			await expect(got).rejects.toThrow(reason === "end" ? "left" : "app.res(1): ended");
			expect(openContext.abortSignal?.aborted).toBe(true);
			late.resolve("value");
			await flushed();
			await host.close(context);
			expect(closes).toEqual([["value", reason, false]]);
		},
	);
});

describe("closing", () => {
	it("closes in reverse, with reason end when the object ends and close when the host closes", async () => {
		const closes: string[] = [];
		const { host } = await loaded((h) =>
			h.serve(Res, ({ id }, self) => {
				for (const name of ["a", "b"]) {
					self.open(
						async () => `${id}${name}`,
						(value, reason) => void closes.push(`${value} ${reason.kind}`),
					);
				}
				return { n: constant(id) };
			}),
		);
		const one = await host.get(Res, { id: 1 }, context);
		await host.get(Res, { id: 2 }, context);
		one.release();
		await flushed();
		await host.close(context);
		expect(closes).toEqual(["1b end", "1a end", "2b close", "2a close"]);
	});

	it("collects every throwing close in host.close; an object ending in the background reports each", async () => {
		const thrown = (name: string) => new Error(`close ${name} threw`);
		const { host, errors } = await loaded((h) =>
			h.serve(Res, ({ id }, self) => {
				for (const name of ["a", "b"]) {
					self.open(
						async () => name,
						() => {
							throw thrown(`${id}${name}`);
						},
					);
				}
				return { n: constant(id) };
			}),
		);
		const one = await host.get(Res, { id: 1 }, context);
		await host.get(Res, { id: 2 }, context);
		one.release();
		await flushed();
		expect(errors).toEqual([
			{ kind: "close_failed", object: "app.res(1)", native: { kind: "native", position: 2 }, error: thrown("1b") },
			{ kind: "close_failed", object: "app.res(1)", native: { kind: "native", position: 1 }, error: thrown("1a") },
		]);
		const closed = await host.close(context).catch((error: unknown) => error);
		expect(closed).toBeInstanceOf(AggregateError);
		expect((closed as AggregateError).errors).toEqual([thrown("2b"), thrown("2a")]);
	});

	describe("timeouts", () => {
		fakeTimers();

		it("report a close still running after its closeTimeout, abort its context then, and close the others", async () => {
			const events: string[] = [];
			let slow: Context | undefined;
			const { host, errors } = await loaded(
				(h) =>
					h.serve(Res, (_, self) => {
						self.open(
							async () => "a",
							() => void events.push("close a"),
						);
						self.open(
							async () => "b",
							(_value, _reason, ctx) => {
								slow = ctx;
								return new Promise(() => {});
							},
							{ closeTimeout: 500 },
						);
						return { n: constant(1) };
					}),
				{ closeTimeout: 10_000 },
			);
			(await host.get(Res, { id: 1 }, context)).release();
			await vi.advanceTimersByTimeAsync(499);
			expect([events, slow?.abortSignal?.aborted]).toEqual([[], false]);
			await vi.advanceTimersByTimeAsync(1);
			expect([events, slow?.abortSignal?.aborted]).toEqual([["close a"], true]);
			expect(errors).toEqual([
				{ kind: "close_timeout", object: "app.res(1)", native: { kind: "native", position: 2 } },
			]);
		});
	});
});

describe("facets", () => {
	it("cannot open natives", () => {
		expectTypeOf<FacetHost>().not.toHaveProperty("open");
	});
});
