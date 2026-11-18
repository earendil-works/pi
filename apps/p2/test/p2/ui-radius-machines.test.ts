// Real browser checks of Radius machines in the Envs sheet: the owner's machines from the fake Radius, "Use" making one an
// environment, "Add machine" showing the install commands, and the machine's own screen. No machine connects.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Envs } from "../../plugins/envs/contract.ts";
import type { EnvConfig } from "../../plugins/envs/schema.ts";
import { writeRadiusConfig } from "../../src/runtime/radius-config.ts";
import { Browser, browserTests, COMPOSER } from "./browser.ts";
import { type Fixture, startFixture } from "./helpers.ts";
import { fakeRadius } from "./radius-fixture.ts";

const SERVER = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";
const button = (text: string) =>
	`[...document.querySelectorAll('[role=dialog] button')].find(e => e.textContent.trim() === ${JSON.stringify(text)})`;

describe("Radius machines UI", { skip: !browserTests }, () => {
	let fixture: Fixture, browser: Browser, radius: Awaited<ReturnType<typeof fakeRadius>>;
	const press = async (text: string) => {
		await browser.wait(button(text));
		await browser.evaluate(`${button(text)}.click()`);
	};
	before(async () => {
		process.env.P2_RADIUS = "0";
		radius = await fakeRadius({ channels: true });
		radius.addMachine(SERVER, "Mario's Laptop");
		fixture = await startFixture({ web: true });
		await writeRadiusConfig(fixture.dataDir, {
			gateway: radius.gateway,
			serverId: crypto.randomUUID(),
			credential: { type: "oauth", access: "fixture-token", refresh: "unused", expires: Date.now() + 3_600_000 },
		});
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
		await browser.metrics(390, 844);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
		await radius?.close();
		delete process.env.P2_RADIUS;
	});

	it("lists the owner's machines, uses one as an environment and shows the install commands", async () => {
		await browser.open(`http://127.0.0.1:${fixture.server.port}/new`);
		await browser.wait(`document.querySelector('${COMPOSER}') && !document.querySelector('.offline')`);
		await browser.openSettings("Environments");
		await browser.wait(`document.querySelector('[role=dialog]').textContent.includes("Mario's Laptop")`);
		await press("Use");
		await browser.wait(`document.querySelector('[role=dialog] input[aria-label="Environment name"]')`);
		assert.equal(
			await browser.evaluate<string>(`document.querySelector('input[aria-label="Environment name"]').value`),
			"mario-s-laptop",
		);
		// The name is taken: Add stays off until another is typed, and the existing environment is left alone.
		const envs = fixture.browser().hold(Envs, {}, BACKGROUND_CONTEXT);
		await envs.save({ name: "mario-s-laptop", config: { type: "ssh", host: "laptop.example" } }, BACKGROUND_CONTEXT);
		await browser.wait(
			`document.querySelector('[role=dialog]').textContent.includes('An environment named mario-s-laptop exists')`,
		);
		assert.equal(await browser.evaluate<boolean>(`${button("Add")}.disabled`), true);
		await envs.delete({ name: "mario-s-laptop" }, BACKGROUND_CONTEXT);
		await browser.wait(`!${button("Add")}.disabled`);
		await press("Add");
		try {
			let config: EnvConfig | undefined;
			for (let attempt = 0; attempt < 100 && config === undefined; attempt++) {
				config = (await envs.list(BACKGROUND_CONTEXT)).find((env) => env.name === "mario-s-laptop")?.config;
				if (config === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
			}
			assert.deepEqual(config, { type: "radius", server: SERVER });
		} finally {
			envs.release();
		}
		await press("As mario-s-laptop");
		await browser.wait(`document.querySelector('[role=dialog] [aria-label=mario-s-laptop] .env-form')`);
		const screen = await browser.evaluate<string>(`document.querySelector('[role=dialog]').textContent`);
		assert.match(screen, /Radius machine · Mario's Laptop · offline/);
		assert.match(screen, new RegExp(SERVER));
		await press("← All environments");
		await browser.wait(button("Add machine"));
		await press("Add machine");
		await browser.wait(`document.querySelector('.env-enrollment textarea')`);
		assert.match(
			await browser.evaluate<string>(`document.querySelector('.env-enrollment textarea').value`),
			/install\.sh \| sh -s -- --gateway http:\/\/127\.0\.0\.1:\d+ --code CODE-1$/,
		);
	});
});
