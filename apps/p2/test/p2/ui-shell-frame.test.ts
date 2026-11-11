// Browser: the app framed by the Radius shell, end to end with the real web bundle. A stand-in shell page on another
// site (`localhost` against the app's `127.0.0.1`) frames the app as Radius does and speaks the shell's side of the
// `pi-shell` channel (src/web/shell-bridge.ts): it answers `ready` with its base and mirrors each reported address
// into its own URL with replaceState. The app is told it is relayed, framed by that origin, as the Radius plugin's
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

/** The stand-in shell: frames `app`, keeps the channel's messages in `window.shellLog`. */
const shellPage = (app: string) => `<!doctype html><title>Shell</title>
<iframe src="${app}/" style="width:1200px;height:800px;border:0"></iframe>
<script>
const frame = document.querySelector("iframe");
const appOrigin = ${JSON.stringify(app)};
window.shellLog = [];
addEventListener("message", (event) => {
	if (event.source !== frame.contentWindow || event.origin !== appOrigin || event.data?.channel !== "pi-shell") return;
	shellLog.push(event.data);
	if (event.data.type === "ready")
		frame.contentWindow.postMessage({ channel: "pi-shell", type: "hello", version: 1, base: location.origin + ${JSON.stringify(BRAIN)} }, appOrigin);
	if (event.data.type === "location") history.replaceState(null, "", ${JSON.stringify(BRAIN)} + (event.data.path === "/" ? "" : event.data.path));
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
});
