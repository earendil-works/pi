// Browser: the app framed by the Radius shell, end to end with the real web bundle. A stand-in shell page on another
// site (`localhost` against the app's `127.0.0.1`) frames the app as Radius does and speaks the shell's side of the
// `pi-shell` channel (src/web/shell-bridge.ts): it answers `ready` with its base and its theme, mirrors each reported
// address into its own URL with replaceState, and owns the theme (src/web/theme.ts, backend `shell`). The app is told it is relayed, framed by that origin, as the Radius plugin's
// request resolver would. The shell's real side is Radius's (its pi-shell e2e test frames a stand-in app instead).
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Models } from "../../plugins/models/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { defineFacet } from "../../src/runtime/chord.ts";
import { RequestResolvers } from "../../src/runtime/server.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture } from "./helpers.ts";

const BRAIN = "/pi/acme/11111111-0000-4000-8000-000000000000";

/**
 * The stand-in shell: frames `app`, keeps the channel's messages in `window.shellLog`. It owns the theme as Radius's
 * shell does: its origin's `pi-theme` (absent: system), resolved with its own matchMedia and applied to its chrome
 * (`<html data-color-scheme>` and `color-scheme`), sent in `hello` and as `theme` on every change; `set-theme` stores
 * and echoes it, `shellSetTheme` is the shell's own change. It frames the app with its resolved scheme as a hint in the
 * URL (`#pi-shell-scheme=`). `?theme=none` is a shell without the theme (its `hello` has none, no hint),
 * `?theme=silent` one without the channel (no `hello`, no hint), `?theme=late` one whose `hello` waits for
 * `shellHello()` and whose frame element is `color-scheme: light`, so the frame's `prefers-color-scheme` is light
 * whatever the shell shows, as in WebKit on a light system.
 */
const shellPage = (app: string) => `<!doctype html><title>Shell</title>
<iframe style="width:1200px;height:800px;border:0"></iframe>
<script>
const frame = document.querySelector("iframe");
const appOrigin = ${JSON.stringify(app)};
const mode = new URLSearchParams(location.search).get("theme");
const system = matchMedia("(prefers-color-scheme: dark)");
window.shellLog = [];
const theme = () => {
	const stored = localStorage.getItem("pi-theme");
	const preference = stored === "light" || stored === "dark" ? stored : "system";
	return { preference, scheme: preference === "system" ? (system.matches ? "dark" : "light") : preference };
};
const post = (message) => frame.contentWindow.postMessage({ channel: "pi-shell", version: 1, ...message }, appOrigin);
const applied = () => {
	const { scheme } = theme();
	document.documentElement.dataset.colorScheme = scheme;
	document.documentElement.style.colorScheme = scheme;
	return theme();
};
const changed = () => mode !== "none" && post({ type: "theme", ...applied() });
window.shellSetTheme = (preference) => {
	if (preference === "system") localStorage.removeItem("pi-theme");
	else localStorage.setItem("pi-theme", preference);
	changed();
};
applied();
if (mode === "late") frame.style.colorScheme = "light";
frame.src = appOrigin + "/" + (mode === "none" || mode === "silent" ? "" : "#pi-shell-scheme=" + theme().scheme);
const hello = () => post({ type: "hello", base: location.origin + ${JSON.stringify(BRAIN)}, ...(mode === "none" ? {} : { theme: theme() }) });
window.shellHello = hello;
system.addEventListener("change", () => theme().preference === "system" && changed());
addEventListener("storage", (event) => event.key === "pi-theme" && changed());
addEventListener("message", (event) => {
	if (event.source !== frame.contentWindow || event.origin !== appOrigin || event.data?.channel !== "pi-shell") return;
	shellLog.push(event.data);
	if (event.data.type === "ready" && mode !== "silent" && mode !== "late") hello();
	if (event.data.type === "location") history.replaceState(null, "", ${JSON.stringify(BRAIN)} + (event.data.path === "/" ? "" : event.data.path));
	if (event.data.type === "set-theme" && mode !== "none") shellSetTheme(event.data.preference);
});
</script>`;

describe("framed by the Radius shell", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let shell: Server;
	let shellOrigin: string;
	let appOrigin: string;
	before(async () => {
		shell = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(shellPage(appOrigin));
		});
		await new Promise<void>((resolve) => shell.listen(0, "127.0.0.1", resolve));
		shellOrigin = `http://localhost:${(shell.address() as AddressInfo).port}`;
		let port = 0;
		// As the Radius plugin marks relayed requests: the owner, from the app's origin, framed by the shell. Only the
		// browser's requests; the test's own clients sign in locally as usual.
		const relayed = defineFacet((_host, self) =>
			self.contribute(RequestResolvers, {
				"test-shell": (request) =>
					request.headers["user-agent"]?.includes("Chrome")
						? {
								principal: { kind: "owner", access: "relay" },
								origin: {
									origin: `http://127.0.0.1:${port}`,
									remote: true,
									port,
									relayShellOrigin: shellOrigin,
								},
							}
						: undefined,
			}),
		);
		fixture = await startFixture({ web: true, facets: [{ name: "test-shell", facet: relayed }] });
		port = fixture.server.port;
		appOrigin = `http://127.0.0.1:${port}`;
		const owner = fixture.browser();
		await owner
			.hold(Models, {}, BACKGROUND_CONTEXT)
			.setDefault({ provider: "faux", modelId: "faux-1", thinkingLevel: "off" }, BACKGROUND_CONTEXT);
		browser = await Browser.start();
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await new Promise<void>((resolve) => shell?.close(() => resolve()));
	});

	const log = () => browser.evaluate<{ type: string; path?: string }[]>("shellLog");
	const inApp = <T>(expression: string) => browser.evaluateInFrame<T>(appOrigin, expression);

	it("mirrors the app's address into the shell's URL, links open the shell, Back moves the app", async () => {
		const sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		const session = await sessions.create({ cwd: fixture.workspace, title: "Framed" }, BACKGROUND_CONTEXT);
		await browser.open(`${shellOrigin}/`);
		await browser.wait(`shellLog.some((message) => message.type === "ready")`);
		await browser.wait(`location.pathname === ${JSON.stringify(BRAIN)}`);

		// Links carry the shell's URL once the shell said its base.
		const row = `document.querySelector('.session-main[href$=${JSON.stringify(`/s/${session.id}`)}]')`;
		await poll(() => inApp<boolean>(`Boolean(${row})`), 30_000, "the session's row");
		assert.equal(await inApp<string>(`${row}.href`), `${shellOrigin}${BRAIN}/s/${session.id}`);

		// Where the app is before the step: its start page, or the session a plugin shows there (the Familiar's).
		await poll(async () => (await log()).some((message) => message.type === "location"), 30_000, "a report");
		const start = (await log()).filter((message) => message.type === "location").at(-1)!.path!;
		const shellUrl = (path: string) => (path === "/" ? BRAIN : `${BRAIN}${path}`);
		await browser.wait(`location.pathname === ${JSON.stringify(shellUrl(start))}`);

		// A plain click acts in the app; the shell's URL follows, one history entry for the step.
		const entries = await browser.evaluate<number>("history.length");
		await inApp(`${row}.click()`);
		await browser.wait(`location.pathname === ${JSON.stringify(`${BRAIN}/s/${session.id}`)}`);
		assert.equal(await browser.evaluate<number>("history.length"), entries + 1);

		// The browser's Back returns the app to where it was, and the shell's URL with it; Forward again.
		await browser.evaluate("history.back()");
		await browser.wait(`location.pathname === ${JSON.stringify(shellUrl(start))}`);
		assert.equal(await inApp<string>("location.pathname"), start);
		await browser.evaluate("history.forward()");
		await browser.wait(`location.pathname === ${JSON.stringify(`${BRAIN}/s/${session.id}`)}`);
		// Only addresses went to the shell, and only to its origin (else the stand-in would not have seen them).
		assert.ok((await log()).every((message) => message.type === "ready" || message.type === "location"));
	});

	describe("theme", () => {
		const shown = () => inApp<string>("document.documentElement.dataset.theme");
		const switchTitle = () => inApp<string>(`document.querySelector(".theme-toggle")?.getAttribute("title") ?? ""`);
		const waitInApp = (expression: string) =>
			poll(() => inApp<boolean>(`Boolean(${expression})`), 30_000, `in the app: ${expression}`);
		const store = (value: string | null) =>
			value === null
				? `localStorage.removeItem("pi-theme")`
				: `localStorage.setItem("pi-theme", ${JSON.stringify(value)})`;
		/**
		 * Opens the shell (`mode`: its `?theme=`) with its own stored preference `preference`, until the app's switch
		 * shows.
		 */
		const openShell = async (preference: string | null, mode?: string) => {
			await browser.open(`${shellOrigin}/?theme=silent`);
			await browser.evaluate(store(preference));
			await browser.open(`${shellOrigin}/${mode === undefined ? "" : `?theme=${mode}`}`);
			// The app's `ready`: its frame is there.
			await browser.wait(`shellLog.some((message) => message.type === "ready")`);
			await poll(async () => (await switchTitle()) !== "", 30_000, "the app's theme switch");
		};
		/**
		 * Stores `value` as the framed app's own `pi-theme` (a stale forced value). Browsers partition a frame's storage by
		 * the top-level site, so only the framed page can write it.
		 */
		const storeInFrame = async (value: string | null) => {
			await openShell(null, "silent");
			await inApp(store(value));
		};
		after(() => browser.call("Emulation.setEmulatedMedia", { features: [] }));

		it("follows the shell, ignores the frame's stale stored value, and sends picks the shell echoes", async () => {
			await storeInFrame("dark");
			await openShell("light");
			await waitInApp(`document.documentElement.dataset.theme === "light"`);
			assert.equal(await switchTitle(), "Theme: Light");

			// The shell's own change (another shell tab, its UI).
			await browser.evaluate(`shellSetTheme("dark")`);
			await waitInApp(`document.documentElement.dataset.theme === "dark"`);
			assert.equal(await switchTitle(), "Theme: Dark");

			// The app's switch (Dark → System): asked of the shell, which stores, applies and echoes it.
			await inApp(`document.querySelector(".theme-toggle").click()`);
			await browser.wait(
				`localStorage.getItem("pi-theme") === null && document.documentElement.dataset.colorScheme === "light"`,
			);
			await waitInApp(`document.documentElement.dataset.theme === "light"`);
			assert.equal(await switchTitle(), "Theme: System");
			assert.deepEqual(
				(await log()).filter((message) => message.type === "set-theme"),
				[{ channel: "pi-shell", version: 1, type: "set-theme", preference: "system" }],
			);
			// System → Light.
			await inApp(`document.querySelector(".theme-toggle").click()`);
			await browser.wait(`localStorage.getItem("pi-theme") === "light"`);
			assert.equal(await switchTitle(), "Theme: Light");
			// The frame's own stored value stayed as it was.
			assert.equal(await inApp<string>(`localStorage.getItem("pi-theme")`), "dark");
		});

		it("takes the shell's resolved scheme under System when the system's changes", async () => {
			await storeInFrame("light");
			await openShell(null);
			await browser.call("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: "dark" }],
			});
			await browser.wait(`document.documentElement.dataset.colorScheme === "dark"`);
			await waitInApp(`document.documentElement.dataset.theme === "dark"`);
			assert.equal(await switchTitle(), "Theme: System");
			await browser.call("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-color-scheme", value: "light" }],
			});
			await waitInApp(`document.documentElement.dataset.theme === "light"`);
		});

		it("keeps the page's own theme with a shell whose hello has none", async () => {
			await storeInFrame("dark");
			await openShell("light", "none");
			await waitInApp(`document.documentElement.dataset.theme === "dark"`);
			assert.equal(await switchTitle(), "Theme: Dark");
			// Dark → System, stored by the page as before; nothing asked of the shell.
			await inApp(`document.querySelector(".theme-toggle").click()`);
			await waitInApp(`localStorage.getItem("pi-theme") === null`);
			assert.ok(!(await log()).some((message) => message.type === "set-theme"));
		});

		it("paints the scheme the shell hinted in the frame's URL before its hello, and removes the hint", async () => {
			// The shell forced dark, the system light, and the frame cannot see the shell's color-scheme (WebKit).
			await storeInFrame("light");
			await openShell("dark", "late");
			assert.deepEqual([await shown(), await switchTitle()], ["dark", "Theme: System"]);
			assert.equal(await inApp<string>("location.hash"), "");
			assert.equal(await inApp<boolean>(`matchMedia("(prefers-color-scheme: dark)").matches`), false);
			await browser.evaluate("shellHello()");
			await waitInApp(`document.querySelector(".theme-toggle").title === "Theme: Dark"`);
			assert.equal(await shown(), "dark");
		});

		it("does not read the frame's stored value without a hello; the system's scheme is the embedder's", async () => {
			await storeInFrame("dark");
			await openShell("light", "silent");
			assert.deepEqual([await shown(), await switchTitle()], ["light", "Theme: System"]);
			// Chrome resolves a frame's prefers-color-scheme with the embedder's color-scheme: the shell's dark.
			await storeInFrame("light");
			await openShell("dark", "silent");
			assert.deepEqual([await shown(), await switchTitle()], ["dark", "Theme: System"]);
		});

		it("keeps the stored value of a page nothing frames", async () => {
			await browser.open(`${appOrigin}/`);
			await browser.evaluate(store("dark"));
			await browser.open(`${appOrigin}/`);
			await browser.wait(`document.querySelector(".theme-toggle")`);
			assert.equal(await browser.evaluate<string>("document.documentElement.dataset.theme"), "dark");
			await browser.evaluate(`document.querySelector(".theme-toggle").click()`);
			assert.equal(await browser.evaluate<string | null>(`localStorage.getItem("pi-theme")`), null);
		});
	});
});
