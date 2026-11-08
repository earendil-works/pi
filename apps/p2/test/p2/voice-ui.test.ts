// Voice mode in a real browser (Chromium's fake microphone): the composer's microphone turns voice mode on, what the
// (fake) speech service hears becomes a message, and the agent's answer is read aloud through /voice/speak.

import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, follow } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import { VoiceMode } from "../../plugins/voice/contract.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, poll, startFixture, until } from "./helpers.ts";
import { fakeSpeechService } from "./voice-service.ts";

describe("voice mode in the browser", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let speech: Awaited<ReturnType<typeof fakeSpeechService>>;
	before(async () => {
		fixture = await startFixture({ web: true });
		speech = await fakeSpeechService("token", { utterance: "What time is it?" });
		writeFileSync(join(fixture.dataDir, "voice.json"), JSON.stringify({ url: speech.url, token: "token" }));
		browser = await Browser.start([
			"--use-fake-ui-for-media-stream",
			"--use-fake-device-for-media-stream",
			"--autoplay-policy=no-user-gesture-required",
		]);
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		speech?.close();
		await fixture?.close();
	});

	it("sends what it hears and reads the answer aloud", async () => {
		const owner = fixture.browser();
		const session = await (await holdIn(owner, Sessions, {}, "owner")).create(
			{ cwd: fixture.workspace },
			BACKGROUND_CONTEXT,
		);
		const input = { session: session.id, conversation: 1 };
		const chat = await holdIn(owner, Chat, input, "participant");
		const keep = follow(chat.view, () => {});
		const mode = await holdIn(owner, VoiceMode, input, "owner");
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${session.id}`);
		await browser.click(".voice-chip");
		await browser.wait('document.querySelector(".voice-orb")');
		await until(mode.enabled, (enabled) => enabled);
		// The composer holds only the orb: what voice mode does is its label, no text beside it.
		await browser.wait(
			'document.querySelector(".voice-chip")?.getAttribute("aria-label")?.includes("Turn voice mode off")',
		);
		assert.equal(
			await browser.evaluate<boolean>('Boolean(document.querySelector(".voice-status, .voice-name"))'),
			false,
		);
		const view = await until(chat.view, (value) =>
			JSON.stringify(value?.entries ?? []).includes("Echo: What time is it?"),
		);
		assert(view);
		await poll(() => speech.spoken.some((said) => said.text === "Echo: What time is it?"), 20_000, "answer spoken");
		assert.deepEqual(
			{ engine: speech.spoken.at(-1)?.engine, voice: speech.spoken.at(-1)?.voice },
			{ engine: "supertonic", voice: "supertonic-F1" },
		);
		// Muted: still in voice mode, but no microphone audio reaches the room, and the room drops what it heard.
		await browser.wait('!document.querySelector(".voice-orb.speaking, .voice-orb.preparing")');
		await browser.click(".voice-mute");
		await browser.wait('document.querySelector(".voice-mute")?.getAttribute("aria-pressed") === "true"');
		await poll(() => speech.commands.some(({ command }) => command.type === "reset"), 5000, "reset on mute");
		const heard = speech.received.length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert.equal(speech.received.length, heard, "nothing sent while muted");
		assert(await browser.evaluate<boolean>('Boolean(document.querySelector(".voice-orb"))'), "voice mode stays on");
		await browser.click(".voice-mute");
		await poll(() => speech.received.length > heard, 5000, "audio again once unmuted");
		// Leaving the conversation (home here; a subagent's the same) suspends voice mode: the orb goes, the switch stays
		// on. Coming back starts it again.
		await browser.evaluate('(history.pushState(null, "", "/"), dispatchEvent(new PopStateEvent("popstate")), true)');
		await browser.wait('!document.querySelector(".voice-orb")');
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(mode.enabled.value, true, "suspended, not switched off");
		await browser.evaluate("(history.back(), true)");
		await browser.wait('document.querySelector(".voice-orb")');
		assert.equal(mode.enabled.value, true);
		// Off again (once the answer is read: a tap while it is read stops only the speech): the switch follows.
		await browser.click(".voice-chip");
		await browser.wait('!document.querySelector(".voice-orb") && !document.querySelector(".voice-mute")');
		await until(mode.enabled, (enabled) => !enabled);
		// The button follows voice.json live, without a reload.
		const file = join(fixture.dataDir, "voice.json");
		renameSync(file, `${file}.away`);
		await browser.wait('!document.querySelector(".voice-chip")');
		renameSync(`${file}.away`, file);
		await browser.wait('document.querySelector(".voice-chip")');
		keep();
		chat.release();
		mode.release();
	});
});
