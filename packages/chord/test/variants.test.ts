// Entry 8: a binding applies a shape only once its new state members have snapshots; members outside the variant
// throw `not_in_variant`; a re-hold after a link loss keeps the last values readable and sends one fresh unit.
import assert from "node:assert/strict";
import { Type } from "typebox";
import { describe, it } from "vitest";
import {
	type Ctx,
	createHost,
	type Facet,
	hostNamed,
	isChordError,
	memoryLinkPair,
	method,
	type Readable,
	remote,
} from "../src/index.ts";
import { CountingLink, stateFrames } from "./fixtures/counting.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, attempts = 200): Promise<void> {
	for (let i = 0; i < attempts && !check(); i++) await sleep(2);
	assert.ok(check(), "condition not reached");
}

const Doc = remote("t.e8-doc", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: {
		a: { state: { x: Type.Number() }, methods: { bump: method() } },
		b: { state: { x: Type.Number(), y: Type.String() }, methods: { bump: method() } },
		c: { state: { y: Type.String() }, methods: { bump: method() } },
	},
});

/** The server's facet: `Doc` in variant `variant` (the cells survive reloads by name). */
function docFacet(variant: "a" | "b" | "c"): Facet {
	return {
		name: "doc",
		setup: (api) =>
			api.serve(Doc, (_input, _principal, self) => {
				const x = self.state("x", Type.Number(), 1);
				const y = self.state("y", Type.String(), "why");
				const bump = (ctx: Ctx) => {
					x.replace(ctx, x.value + 1);
				};
				if (variant === "a") return { variant, x, bump };
				if (variant === "b") return { variant, x, y, bump };
				return { variant, y, bump };
			}),
	};
}

/** A reference whose variant changes under the test: its members, typed loosely (TypeScript narrows only once). */
type View = { readonly variant: string | undefined; readonly x: Readable<number>; readonly y: Readable<string> };
const view = (ref: object): View => ref as unknown as View;

function setup() {
	const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
	const [down, up] = memoryLinkPair();
	server.accept(down, { principal: { user: "u" } });
	const link = new CountingLink(up);
	const browser = createHost({
		self: { kind: "host" },
		name: "browser",
		kind: "client",
		upstream: { link, principal: { kind: "server" } },
		onError: () => {},
	});
	return { server, browser, link };
}

describe("variants", () => {
	it("a new variant's members arrive with its shape; a member outside the variant throws not_in_variant", async () => {
		const { server, browser, link } = setup();
		await server.install(docFacet("a"));
		const doc = browser.hold(Doc, {});
		await doc.ready;
		assert.equal(view(doc).variant, "a");
		assert.equal(view(doc).x.value, 1);
		assert.throws(
			() => view(doc).y.value,
			(error) => isChordError(error, "not_in_variant"),
		);
		// Every shape the reference shows is readable in full, at the moment it is shown.
		const failures: unknown[] = [];
		doc.onShape((shape) => {
			for (const name of ["x", "y"]) {
				const member = Doc.description.variants[shape.variant ?? ""]?.[name];
				if (member?.kind !== "state") continue;
				try {
					void (view(doc) as unknown as Record<string, Readable<unknown>>)[name]!.value;
				} catch (error) {
					failures.push(error);
				}
			}
		});
		const before = stateFrames(link.received).length;
		await server.reload([docFacet("b")]);
		await until(() => view(doc).variant === "b");
		assert.equal(view(doc).y.value, "why");
		assert.equal(view(doc).x.value, 1);
		const unit = stateFrames(link.received).slice(before);
		assert.deepEqual(
			unit.filter((frame) => frame.as === "snap").map((frame) => frame.m),
			["y"],
			"only the new member's snapshot",
		);
		await server.reload([docFacet("c")]);
		await until(() => view(doc).variant === "c");
		assert.throws(
			() => view(doc).x.value,
			(error) => isChordError(error, "not_in_variant"),
		);
		assert.equal(view(doc).y.value, "why");
		assert.deepEqual(failures, []);
		await browser.close();
		await server.close();
	});
});

describe("re-hold after a link loss", () => {
	it("keeps the last values readable, sends one fresh unit, and a reference joining meanwhile waits for it", async () => {
		const server = createHost({ self: { kind: "host" }, name: "server", onError: () => {} });
		await server.install(docFacet("b"));
		const [down, up] = memoryLinkPair();
		server.accept(down, { principal: { user: "u" } });
		const browser = createHost({
			self: { kind: "host" },
			name: "browser",
			kind: "client",
			upstream: { link: up, principal: { kind: "server" } },
			onError: () => {},
		});
		const doc = browser.hold(Doc, {});
		await doc.ready;
		await doc.bump();
		await until(() => view(doc).x.value === 2);
		up.close();
		await until(() => doc.status === "loading");
		// The last values stay readable while the binding re-holds.
		assert.equal(view(doc).x.value, 2);
		const joining = browser.hold(Doc, {});
		assert.equal(joining.status, "loading");
		let joined = false;
		void joining.ready.then(() => {
			joined = true;
		});
		await sleep(5);
		assert.equal(joined, false, "a reference joining during the re-hold waits for the fresh unit");

		const [down2, up2] = memoryLinkPair();
		server.accept(down2, { principal: { user: "u" } });
		const link = new CountingLink(up2);
		browser.connect(link, { principal: { kind: "server" } });
		await joining.ready;
		assert.equal(doc.status, "live");
		const hold = link.sent.find((frame) => frame.t === "hold");
		assert.ok(hold?.t === "hold" && hold.again === true, "a re-hold says again");
		assert.equal(link.count("sent", "hold"), 1, "one hold for both references");
		const snaps = stateFrames(link.received).filter((frame) => frame.as === "snap");
		assert.deepEqual(snaps.map((frame) => frame.m).sort(), ["x", "y"], "one snapshot per member");
		// The old hold was released with the link: the server made a fresh object (its cells start over).
		assert.equal(view(doc).x.value, 1);
		await browser.close();
		await server.close();
	});
});
