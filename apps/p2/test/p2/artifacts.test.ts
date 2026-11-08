import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Held, whenLive } from "@p2/app/v1";
import type { ArtifactInfo } from "../../plugins/artifacts/contract.ts";
import { ArtifactContent, ArtifactList, MAX_ARTIFACT_PREVIEW } from "../../plugins/artifacts/contract.ts";
import { MAX_ARTIFACT_BYTES, saveArtifact } from "../../plugins/artifacts/store.ts";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import type { Host, RefIn } from "../../src/runtime/chord.ts";
import { Hosts } from "../../src/runtime/server.ts";
import { expectChord, type Fixture, holdIn, http, settled, startFixture, until } from "./helpers.ts";

const results = (view: ConversationView | null | undefined): ToolResultMessage[] =>
	(view?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "artifact",
		),
	);
const TUNNEL = { Host: "share.test", Origin: "https://share.test" };

describe("artifacts (fake provider)", () => {
	let fixture: Fixture;
	let owner: Host;
	let session: string;
	let other: string;
	let chat: RefIn<typeof Chat, "participant">;
	let list: Held<typeof ArtifactList>;
	before(async () => {
		fixture = await startFixture({ allowedHosts: ["share.test"] });
		owner = fixture.browser();
		const sessions = await holdIn(owner, Sessions, {}, "owner");
		session = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		other = (await sessions.create({ cwd: fixture.workspace }, BACKGROUND_CONTEXT)).id;
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		list = owner.hold(ArtifactList, { session, conversation: 1 }, BACKGROUND_CONTEXT);
	});
	after(async () => {
		await fixture?.close();
	});
	const url = (name = "demo", version = 1, id = session) =>
		`/artifact?${new URLSearchParams({ session: id, name, version: String(version) })}`;

	it("publishes immutable numbered versions and indexes them outside the transcript", async () => {
		for (let version = 1; version <= 2; version++) {
			await chat.send({ text: "artifact", requestId: `artifact-${version}` }, BACKGROUND_CONTEXT);
			const view = await until(
				chat.view,
				(value) => results(value).length === version && !(value?.docs["pi.live"] as { run?: unknown })?.run,
			);
			assert.equal(results(view).at(-1)?.isError, false);
			assert.equal((results(view).at(-1)?.details as { version: number }).version, version);
		}
		const index = await until(list.artifacts, (value) => value?.length === 2);
		assert.deepEqual(
			index?.map((artifact) => artifact.version),
			[1, 2],
		);
		const source = await http(fixture.server.port, `${url()}&download=1`);
		assert.equal(source.status, 200);
		assert.equal(source.body, "<!doctype html><title>Demo</title><h1>Artifact demo</h1>");
		assert.match(String(source.headers["content-disposition"]), /attachment; filename="demo.html"/);
	});

	it("isolates executable previews and instruments only the preview, with correct HEAD", async () => {
		const preview = await http(fixture.server.port, url());
		assert.equal(preview.status, 200);
		assert.match(preview.body, /p2-artifact-diagnostic/);
		assert.equal(preview.headers["content-type"], "text/html; charset=utf-8");
		const csp = String(preview.headers["content-security-policy"]);
		assert.match(csp, /sandbox allow-scripts allow-modals allow-pointer-lock/);
		assert.ok(!csp.includes("allow-same-origin"));
		assert.match(csp, /frame-src 'none'.*object-src 'none'.*base-uri 'none'.*form-action 'none'/);
		assert.equal(preview.headers["cross-origin-resource-policy"], "same-origin");
		const head = await http(fixture.server.port, url(), { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.body, "");
		assert.equal(head.headers["content-length"], preview.headers["content-length"]);
		assert.equal(
			(await http(fixture.server.port, url(), { headers: { "Sec-Fetch-Site": "cross-site" } })).status,
			403,
		);
		for (const path of [url("../demo"), url("demo", 0), url("demo", 99), url("demo", 1, other)])
			assert.equal((await http(fixture.server.port, path)).status, 404);
	});

	it("retains both versions and the independent index across worker restart and compatible reload", async () => {
		await fixture.server.reload(["artifacts"]);
		await until(list.artifacts, (value) => value?.length === 2);
		await fixture.server.host.root(
			async (ctx) => (await ctx.get(Hosts, {})).stop({ session }, ctx),
			BACKGROUND_CONTEXT,
		);
		chat.release();
		list.release();
		chat = await holdIn(owner, Chat, { session, conversation: 1 }, "participant");
		list = owner.hold(ArtifactList, { session, conversation: 1 }, BACKGROUND_CONTEXT);
		const index = await until(list.artifacts, (value) => value?.length === 2);
		assert.deepEqual(
			index?.map((artifact) => artifact.version),
			[1, 2],
		);
		assert.equal(
			(await http(fixture.server.port, `${url("demo", 1)}&download=1`)).body,
			(await http(fixture.server.port, `${url("demo", 2)}&download=1`)).body,
		);
	});

	it("authorizes guests per session, including reads of the artifact index", async () => {
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => Boolean(value?.length));
		const joined = await http(fixture.server.port, "/join", {
			method: "POST",
			headers: { ...TUNNEL, "Content-Type": "application/json" },
			body: JSON.stringify({ token: links?.[0]?.token, name: "Reader" }),
		});
		assert.equal(joined.status, 200);
		const cookie = String(joined.headers["set-cookie"]).split(";")[0]!;
		const headers = { ...TUNNEL, Cookie: cookie };
		assert.equal((await http(fixture.server.port, url(), { headers })).status, 200);
		assert.equal((await http(fixture.server.port, url("demo", 1, other), { headers })).status, 403);
		assert.equal((await http(fixture.server.port, url(), { headers: TUNNEL })).status, 403);
		const guest = fixture.client(headers).host;
		const index = guest.hold(ArtifactList, { session, conversation: 1 }, BACKGROUND_CONTEXT);
		await until(index.artifacts, (value) => value?.length === 2);
		const refused = guest.hold(ArtifactList, { session: other, conversation: 1 }, BACKGROUND_CONTEXT);
		await expectChord(whenLive(refused), "forbidden");
		refused.release();
		// The TUI's inline view: the same authority as the route.
		const content = guest.hold(ArtifactContent, { session }, BACKGROUND_CONTEXT);
		await whenLive(content);
		assert.equal(content.variant, "reader");
		if (content.variant === "reader") {
			const read = await content.read({ name: "demo", version: 1 }, BACKGROUND_CONTEXT);
			assert.equal(read.content, "<!doctype html><title>Demo</title><h1>Artifact demo</h1>");
			assert.equal(read.info.type, "html");
			assert.equal(read.truncated, false);
			await assert.rejects(content.read({ name: "demo", version: 99 }, BACKGROUND_CONTEXT), /not found/i);
		}
		content.release();
		const elsewhere = guest.hold(ArtifactContent, { session: other }, BACKGROUND_CONTEXT);
		await expectChord(whenLive(elsewhere), "forbidden");
		elsewhere.release();
		index.release();
		await guest.close(BACKGROUND_CONTEXT);
		sharing.release();
	});

	it("carries inline in the result details only, and keeps the index and stored version unchanged", async () => {
		const svg =
			"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100'><rect width='200' height='100'/></svg>";
		const call = { name: "flow", title: "Flow", type: "svg", content: svg, inline: true };
		const before = results(await settled(chat.view)).length;
		await chat.send({ text: `artifact ${JSON.stringify(call)}`, requestId: "inline-svg" }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(value) => results(value).length === before + 1 && !(value?.docs["pi.live"] as { run?: unknown })?.run,
		);
		const result = results(view).at(-1);
		assert.equal(result?.isError, false);
		assert.deepEqual(result?.details, { name: "flow", title: "Flow", type: "svg", version: 1, inline: true });
		assert.match(JSON.stringify(result?.content), /Shown inline in the transcript/);
		// The plain call has no flag at all.
		assert.deepEqual(results(view)[0]?.details, { name: "demo", title: "Demo artifact", type: "html", version: 1 });
		const index = await until(list.artifacts, (value) => Boolean(value?.some((entry) => entry.name === "flow")));
		assert.deepEqual(
			index?.find((entry) => entry.name === "flow"),
			{ name: "flow", title: "Flow", type: "svg", version: 1 },
		);
		assert.equal((await http(fixture.server.port, `${url("flow")}&download=1`)).body, svg);
		// The preview's bridge is CDATA inside the root (SVG is XML) and reports the content height.
		const preview = (await http(fixture.server.port, url("flow"))).body;
		assert.ok(preview.startsWith("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 100'><script><![CDATA["));
		assert.match(preview, /level:"size"/);
		assert.ok(preview.endsWith("]]></script><rect width='200' height='100'/></svg>"));
	});

	/** Saves a new artifact (a name not saved before) through the tool on the session's worker: its info. */
	let saves = 0;
	const save = async (call: { name: string; title: string; type: string; content: string }) => {
		const saved = (value: ConversationView | null | undefined) =>
			results(value).find((result) => (result.details as ArtifactInfo | undefined)?.name === call.name);
		await chat.send({ text: `artifact ${JSON.stringify(call)}`, requestId: `save-${++saves}` }, BACKGROUND_CONTEXT);
		const view = await until(
			chat.view,
			(value) => saved(value) !== undefined && !(value?.docs["pi.live"] as { run?: unknown })?.run,
			30_000,
		);
		return saved(view)!.details as ArtifactInfo;
	};

	it("serves Markdown/text as non-executable documents and validates byte bounds", async () => {
		for (const type of ["markdown", "text", "svg"] as const) {
			const info = await save({
				name: type,
				title: type,
				type,
				content: type === "svg" ? "<svg xmlns='http://www.w3.org/2000/svg'/>" : "# safe <script>no</script>",
			});
			const response = await http(fixture.server.port, url(info.name, info.version));
			assert.equal(response.status, 200);
			// An empty root has no inside for the bridge: served as stored, still well-formed XML.
			if (type === "svg") assert.equal(response.body, "<svg xmlns='http://www.w3.org/2000/svg'/>");
			else {
				assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
				assert.match(String(response.headers["content-security-policy"]), /; sandbox$/);
				assert.ok(!response.body.includes("p2-artifact-diagnostic"));
			}
		}
		// Inline previews stop at MAX_ARTIFACT_PREVIEW characters and say so.
		// Made by a code mode script: a message of half a MiB would be the test's own problem.
		const script = `await tools.artifact({ name: "long", title: "Long", type: "text", content: "x".repeat(${MAX_ARTIFACT_PREVIEW + 10}) })`;
		await chat.send({ text: `codemode ${script}`, requestId: "save-long" }, BACKGROUND_CONTEXT);
		const listed = await until(
			list.artifacts,
			(value) => Boolean(value?.some((entry) => entry.name === "long")),
			30_000,
		);
		const long = listed!.find((entry) => entry.name === "long")!;
		const content = owner.hold(ArtifactContent, { session }, BACKGROUND_CONTEXT);
		await whenLive(content);
		if (content.variant === "reader") {
			const read = await content.read({ name: long.name, version: long.version }, BACKGROUND_CONTEXT);
			assert.equal(read.truncated, true);
			assert.equal(read.content.length, MAX_ARTIFACT_PREVIEW);
		}
		content.release();
		// Refused before the session's files are touched.
		await assert.rejects(
			saveArtifact(
				{} as Parameters<typeof saveArtifact>[0],
				{ name: "large", title: "Large", type: "text", content: "é".repeat(MAX_ARTIFACT_BYTES / 2 + 1) },
				"1",
				// Never reached: validation refuses first.
				{} as Parameters<typeof saveArtifact>[3],
			),
			/2 MiB/,
		);
	});
});
