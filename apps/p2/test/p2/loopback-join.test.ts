// Share links opened on loopback: the owner's browser carries a local owner session (from a sign-in link opened on the
// host) and skips the join form; a browser without it (a fresh profile, incognito) gets the join form, and once joined
// its guest cookie makes it that guest everywhere, while the owner's browser stays the owner. Loopback alone is nobody.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { Sharing } from "../../plugins/sharing/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, http, startFixture, until } from "./helpers.ts";

const setInput = (selector: string, value: string) =>
	`(() => { const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`;

const cookieOf = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined =>
	[headers["set-cookie"] ?? []]
		.flat()
		.map((cookie) => cookie.split(";")[0]!)
		.find((cookie) => cookie.startsWith(`${name}=`));

describe("share links on loopback", () => {
	let fixture: Fixture;
	let session: string;
	let view: string;
	let full: string;

	before(async () => {
		fixture = await startFixture({ web: !!browserTests });
		const owner = fixture.browser();
		session = (
			await (
				await holdIn(owner, Sessions, {}, "owner")
			).create({ cwd: fixture.workspace, title: "Shared" }, BACKGROUND_CONTEXT)
		).id;
		const sharing = owner.hold(Sharing, { session }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "view" }, BACKGROUND_CONTEXT);
		await sharing.link({ mode: "full" }, BACKGROUND_CONTEXT);
		const links = await until(sharing.links, (value) => value?.length === 2);
		view = new URL(links!.find((link) => link.mode === "view")!.url).pathname;
		full = new URL(links!.find((link) => link.mode === "full")!.url).pathname;
	});
	after(() => fixture?.close());

	it("gives a cookieless browser the join form and the owner's browser the session", async () => {
		const port = fixture.server.port;
		const origin = `http://127.0.0.1:${port}`;
		const host = { Host: `127.0.0.1:${port}` };
		// No cookie: someone joining.
		const fresh = await http(port, view, { headers: host });
		assert.equal(fresh.status, 200);
		assert.match(fresh.body, /<form id="join">/);
		// A cookieless browser loading the app is asked to sign in, and gets no cookie.
		const app = await http(port, "/", { headers: { ...host, "Sec-Fetch-Site": "none" } });
		assert.equal(app.status, 401);
		assert.equal(app.headers["set-cookie"], undefined);
		// The owner's browser signs in with an owner link opened on the host: a local session.
		const { token } = JSON.parse(
			(await http(port, "/owner-token", { headers: { Cookie: fixture.owner.cookie } })).body,
		) as { token: string };
		const claimed = await http(port, "/owner/claim", {
			method: "POST",
			headers: { ...host, Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		const device = cookieOf(claimed.headers, `p2_owner_${port}`);
		assert.ok(device, "the claim sets the local owner session cookie");
		assert.match([claimed.headers["set-cookie"]].flat().join(), /=local\..*; HttpOnly; SameSite=Lax; Path=\//);
		const owner = await http(port, view, { headers: { ...host, Cookie: device } });
		assert.equal(owner.status, 303);
		assert.equal(owner.headers.location, `/s/${session}`);
		// A forged cookie is not the owner's.
		const forged = await http(port, view, {
			headers: { ...host, Cookie: `p2_owner_${port}=local.${"0".repeat(32)}.9999999999999.${"0".repeat(64)}` },
		});
		assert.equal(forged.status, 200);

		// Joining sets a guest cookie, which makes that browser the guest for every request.
		const joined = await http(port, "/join", {
			method: "POST",
			headers: { ...host, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: JSON.stringify({ token: view.split("/").pop(), name: "Viewer" }),
		});
		assert.equal(joined.status, 200, joined.body);
		const guest = cookieOf(joined.headers, `p2_guest_${port}`);
		assert.ok(guest);
		const check = await http(port, "/owner/check", { headers: { ...host, Cookie: guest } });
		assert.equal(check.status, 401, "a guest is not the owner on loopback");
		const page = await http(port, "/", { headers: { ...host, Cookie: guest, "Sec-Fetch-Site": "none" } });
		assert.equal(cookieOf(page.headers, `p2_owner_${port}`), undefined, "a guest never gets the owner cookie");
		// The owner's browser with a guest cookie too: its owner cookie wins (Pi Mobile: owner before guest).
		const both = await http(port, "/owner/check", { headers: { ...host, Cookie: `${guest}; ${device}` } });
		assert.equal(both.status, 200);
		// Cookieless loopback clients are nobody: the TUI and owner-link sign in with the data directory's key.
		assert.equal((await http(port, "/owner/check", { headers: host })).status, 401);
	});

	it(
		"in Chromium: the owner stays owner; fresh profiles join read-only and read/write",
		{ skip: !browserTests, timeout: 120_000 },
		async () => {
			const origin = `http://127.0.0.1:${fixture.server.port}`;
			const owner = await Browser.start();
			const viewer = await Browser.start();
			const writer = await Browser.start();
			const ownerUi = `document.querySelector('.composer textarea') && !document.querySelector('nav[aria-label="Shared session"]') && !document.querySelector('.offline')`;
			try {
				// The owner's browser opens a sign-in link on the host, as the server prints at startup.
				const { token } = JSON.parse(
					(await http(fixture.server.port, "/owner-token", { headers: { Cookie: fixture.owner.cookie } })).body,
				) as { token: string };
				await owner.open(`${origin}/owner#${token}`);
				await owner.wait(`location.pathname === "/"`);
				await owner.wait(ownerUi);
				assert.equal(await owner.evaluate<string>("location.hash"), "", "the token left the address bar");
				// The owner opening its own link goes straight to the session.
				await owner.open(`${origin}${view}`);
				await owner.wait(`location.pathname === ${JSON.stringify(`/s/${session}`)}`);
				await owner.wait(ownerUi);

				// A fresh profile (incognito) gets the join form and joins read-only: no composer, cannot send.
				await viewer.open(`${origin}${view}`);
				await viewer.wait(`document.querySelector('#join #name') && document.querySelector('#join button')`);
				await viewer.evaluate(setInput("#name", "Incognito"));
				await viewer.click("#join button");
				await viewer.wait(
					`document.querySelector('nav[aria-label="Shared session"]') && document.querySelector('.subagent-bar')?.textContent.includes('Joined as Incognito · read-only') && !document.querySelector('.offline')`,
				);
				assert.equal(
					await viewer.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`),
					false,
				);
				const denied = await viewer.evaluate<number[]>(
					`Promise.all(['/owner/check','/owner-token'].map((path)=>fetch(path).then((r)=>r.status)))`,
				);
				assert.deepEqual(denied, [401, 403]);
				// Still the guest on the app's start page (its guest cookie wins over loopback).
				await viewer.open(`${origin}/`);
				await viewer.wait(
					`document.querySelector('nav[aria-label="Shared session"]') && !document.querySelector('.offline')`,
				);
				assert.equal(
					await viewer.evaluate<boolean>(`Boolean(document.querySelector('.composer textarea'))`),
					false,
				);

				// A read/write link gives a full guest, who can send.
				await writer.open(`${origin}${full}`);
				await writer.wait(`document.querySelector('#join #name')`);
				await writer.evaluate(setInput("#name", "Writer"));
				await writer.click("#join button");
				await writer.wait(
					`document.querySelector('nav[aria-label="Shared session"]') && document.querySelector('.composer textarea') && !document.querySelector('.offline')`,
				);
				await writer.evaluate(setInput(".composer textarea", "hello from the writer"));
				await writer.click("button[aria-label=Send]");
				const chat = await holdIn(fixture.browser(), Chat, { session, conversation: 1 }, "participant");
				await until(chat.view, (value) => JSON.stringify(value?.entries ?? []).includes("hello from the writer"));

				// The owner's browser is unaffected.
				await owner.open(`${origin}/`);
				await owner.wait(ownerUi);
				assert.equal(await owner.evaluate<number>(`fetch('/owner/check').then((r)=>r.status)`), 200);
			} finally {
				await owner.close();
				await viewer.close();
				await writer.close();
			}
		},
	);
});
