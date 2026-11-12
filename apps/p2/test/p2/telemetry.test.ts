// Telemetry (Chord §29): the server records to `<data>/telemetry.sqlite` (src/runtime/host-dirs.ts); a session worker's
// spans (Chord's, Durable's, pi-ai's) reach it over the worker's link, stamped with its host; owners' pages may send
// theirs and are marked to record, guests' may not; what a span records about its principal is p2's hook, never a name
// or an email. Fake provider, disposable data.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PageTelemetry } from "@earendil-works/chord/telemetry-ingest";
import { openTelemetryStore } from "@earendil-works/chord/telemetry-sqlite/node";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { StoredSpan } from "@earendil-works/pi-telemetry";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Session } from "../../src/runtime/chord.ts";
import { telemetryStore } from "../../src/runtime/host-dirs.ts";
import { type GuestPrincipal, principalAttributes } from "../../src/runtime/principals.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";

const live = (view: ConversationView | null | undefined) => view?.docs["pi.live"] as LiveState | undefined;

const GUEST: GuestPrincipal = {
	kind: "guest",
	id: "g-1",
	name: "Ada Lovelace",
	email: "ada@example.com",
	home: "s",
	sessions: {},
	revision: 1,
};

describe("telemetry", () => {
	let fixture: Fixture;
	let session: string;
	before(async () => {
		fixture = await startFixture({ web: browserTests });
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Traced" }, BACKGROUND_CONTEXT)
		).id;
		const chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		await chat.send({ text: "hello", requestId: "hello" }, BACKGROUND_CONTEXT);
		await until(chat.view, (view) => !live(view)?.run && JSON.stringify(view).includes("Echo: hello"), 30_000);
		chat.release();
	});
	after(() => fixture?.close());

	/** Every span stored now in traces matching `attributes` (the store's read-only view, as scripts/traces.ts reads). */
	const stored = async (attributes: Readonly<Record<string, string>>): Promise<StoredSpan[]> => {
		const store = await openTelemetryStore(telemetryStore(fixture.dataDir));
		try {
			const { traces } = await store.findTraces({ attributes, limit: 200 });
			return traces.flatMap((trace) => trace.spans);
		} finally {
			await store.close();
		}
	};

	it("stores the session worker's spans, Durable's and pi-ai's among them, stamped with its host", async () => {
		const worker = Session({ id: session }).key;
		let spans: StoredSpan[] = [];
		await poll(
			async () => {
				spans = (await stored({ "chord.host": worker })).filter((span) => span.attributes["chord.host"] === worker);
				const names = new Set(spans.map((span) => span.name));
				return names.has("pi.durable.submit") && names.has("pi.ai.request") && names.has("chord.method");
			},
			20_000,
			"the worker's spans in the store",
		);
		// The owner's call, relayed by the server, runs on the worker as the owner: p2's attributes, not the principal key.
		const method = spans.find((span) => span.name === "chord.method" && span.attributes["p2.principal"]);
		assert.equal(method?.attributes["p2.principal"], "owner:local");
		assert.equal(method?.attributes["chord.principal"], undefined);
	});

	it("admits owners' pages only, and records no name or email of anyone", async () => {
		const guest = fixture.as(GUEST);
		const refused = await guest.get(PageTelemetry, {}, BACKGROUND_CONTEXT).catch((error: unknown) => error);
		assert.match(String((refused as { code?: string }).code), /forbidden/);
		const owner = fixture.browser();
		const page = await owner.get(PageTelemetry, {}, BACKGROUND_CONTEXT);
		assert.deepEqual(await page.ingest({ spans: [] }, BACKGROUND_CONTEXT), { written: 0, dropped: 0 });
		page.release();
		assert.deepEqual(principalAttributes(GUEST), { "p2.principal": "guest", "p2.guest": "g-1" });
		assert.deepEqual(principalAttributes({ kind: "owner", access: "device", device: "d" }), {
			"p2.principal": "owner:device",
		});
		assert.deepEqual(principalAttributes({ kind: "worker", session: "s", generation: 2 }), {
			"p2.principal": "worker",
			"p2.session": "s",
		});
	});

	it("marks an owner's page to record, and stores its spans as the browser's", { skip: !browserTests }, async () => {
		const browser = await Browser.start();
		try {
			await browser.signIn(fixture.owner);
			await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session}`);
			await browser.wait("document.getElementById('root')?.dataset.p2Telemetry === 'on'");
			await browser.wait("document.querySelector('.composer textarea')");
			let spans: StoredSpan[] = [];
			await poll(
				async () => {
					spans = (await stored({ "chord.host": "browser" })).filter(
						(span) => span.attributes["chord.host"] === "browser",
					);
					return spans.some((span) => span.name === "chord.hold");
				},
				20_000,
				"the page's spans in the store",
			);
			assert.equal(spans[0]?.attributes["p2.principal"], "owner:local");
		} finally {
			await browser.close();
		}
	});
});
