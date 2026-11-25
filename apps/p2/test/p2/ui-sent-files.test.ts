// Sent files in Chromium: an image `send_file` sent shows as a thumbnail in its card (fitted, never enlarged), other
// files as the plain card, and the viewer the card opens fits a tall image inside its area (WebKit once centred it below
// the view). Fake provider (`send_file <json>`), disposable sessions.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { deflateSync } from "node:zlib";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { Chat } from "../../plugins/chat/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { RefIn } from "../../src/runtime/chord.ts";
import { Browser, browserTests } from "./browser.ts";
import { type Fixture, holdIn, startFixture, until } from "./helpers.ts";

/** A grey RGB PNG of `width` × `height` pixels. */
function png(width: number, height: number): Buffer {
	const chunk = (type: string, data: Buffer): Buffer => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const card = (name: string) =>
	`[...document.querySelectorAll('.file-card')].find((e)=>e.querySelector('.file-card-text strong')?.textContent===${JSON.stringify(name)})`;
const rect = (expression: string) =>
	`(() => { const r=(${expression}).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`;

type Rect = { x: number; y: number; width: number; height: number };

describe("sent files in Chromium", { skip: !browserTests }, () => {
	let fixture: Fixture;
	let browser: Browser;
	let sessions: RefIn<typeof Sessions, "owner">;

	/** A new session whose agent sends each of `paths` (files in the workspace). */
	const send = async (title: string, paths: string[]): Promise<string> => {
		const id = (await sessions.create({ cwd: fixture.workspace, title }, BACKGROUND_CONTEXT)).id;
		const chat = await holdIn(fixture.browser(), Chat, { session: id, conversation: 1 }, "participant");
		for (const [index, path] of paths.entries()) {
			await chat.send(
				{ text: `send_file ${JSON.stringify({ path })}`, requestId: `send-${index}` },
				BACKGROUND_CONTEXT,
			);
			await until(chat.view, (view) => {
				const sent = (view?.entries ?? []).flatMap((entry) =>
					(entry.model ?? []).filter(
						(message): message is ToolResultMessage =>
							message.role === "toolResult" && message.toolName === "send_file" && !message.isError,
					),
				);
				return sent.length === index + 1 && !(view?.docs["pi.live"] as { run?: unknown })?.run;
			});
		}
		chat.release();
		return id;
	};

	before(async () => {
		fixture = await startFixture({ web: true });
		writeFileSync(join(fixture.workspace, "small.png"), png(40, 80));
		writeFileSync(join(fixture.workspace, "tall.png"), png(400, 3000));
		writeFileSync(join(fixture.workspace, "notes.txt"), "plain text\n");
		sessions = await holdIn(fixture.browser(), Sessions, {}, "owner");
		browser = await Browser.start();
		await browser.signIn(fixture.owner);
	});
	after(async () => {
		await browser?.close();
		await fixture?.close();
	});

	it("shows an image as a fitted thumbnail and other files as the plain card", async () => {
		const id = await send("Sent files", ["small.png", "tall.png", "notes.txt"]);
		await browser.metrics(1200, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(card("notes.txt"));
		// Thumbnails load lazily: each loads once its card is on screen.
		for (const [name, width] of [
			["small.png", 40],
			["tall.png", 400],
		] as const) {
			await browser.evaluate(`${card(name)}.scrollIntoView({ block: "center" })`);
			await browser.wait(`${card(name)}.querySelector('.file-card-thumbnail img').naturalWidth===${width}`);
		}
		assert.equal(
			await browser.evaluate<boolean>(`!!${card("notes.txt")}.querySelector('.file-card-thumbnail')`),
			false,
		);
		// The thumbnail box has a fixed height; a small image keeps its size, a tall one fits the box.
		const box = await browser.evaluate<Rect>(rect(`${card("tall.png")}.querySelector('.file-card-thumbnail')`));
		assert.equal(Math.round(box.height), 240);
		const small = await browser.evaluate<{ width: number; height: number }>(
			`(() => { const i=${card("small.png")}.querySelector('img'); return { width: i.width, height: i.height }; })()`,
		);
		assert.ok(small.width > 40, "the img box spans the card; object-fit decides the drawn size");
		assert.equal(
			await browser.evaluate<string>(`getComputedStyle(${card("small.png")}.querySelector('img')).objectFit`),
			"scale-down",
		);
		// The duplicate opener stays out of the tab order.
		assert.equal(
			await browser.evaluate<string>(
				`${card("tall.png")}.querySelector('.file-card-thumbnail').getAttribute('tabindex')`,
			),
			"-1",
		);
	});

	it("opens the viewer from the thumbnail, the tall image fitted inside its area", async () => {
		const id = await send("Sent tall image", ["tall.png"]);
		await browser.metrics(1200, 900);
		await browser.open(`http://127.0.0.1:${fixture.server.port}/s/${id}`);
		await browser.wait(`${card("tall.png")}?.querySelector('.file-card-thumbnail img')?.naturalWidth===400`);
		await browser.evaluate(`${card("tall.png")}.querySelector('.file-card-thumbnail').click()`);
		await browser.wait(`document.querySelector('.viewer-panel img.file-media')?.complete`);
		const area = await browser.evaluate<Rect>(rect(`document.querySelector('.viewer-content.media')`));
		const image = await browser.evaluate<Rect>(rect(`document.querySelector('.viewer-panel img.file-media')`));
		assert.ok(image.y >= area.y && image.y + image.height <= area.y + area.height, JSON.stringify({ area, image }));
		assert.ok(image.x >= area.x && image.x + image.width <= area.x + area.width, JSON.stringify({ area, image }));
	});
});
