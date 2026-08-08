import assert from "node:assert";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import {
	encodeKitty,
	hyperlink,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

class RecordingTerminal extends VirtualTerminal {
	readonly events: Array<{ type: "write"; data: string } | { type: "start" } | { type: "stop" }> = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}
}

describe("TuiAltScreen", () => {
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10"],
		);
		assert.strictEqual(tui.isFollowingOutput, true);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(tui.isFollowingOutput, false);

		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);

		tui.stop();
	});

	it("keeps an explicit dock fixed while the transcript scrolls", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);

		// Wheel over the dock falls back to the primary transcript scroll view.
		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);
		assert.strictEqual(transcript.isFollowingEnd, false);

		transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10", "editor", "footer"],
		);
		tui.stop();
	});

	it("invalidates overlays with an explicit layout root", () => {
		const tui = new TuiAltScreen(new VirtualTerminal());
		const overlay = new Text("overlay", 0, 0);
		let invalidated = false;
		overlay.invalidate = () => {
			invalidated = true;
		};
		tui.setLayoutRoot(new Text("root", 0, 0));
		tui.showOverlay(overlay);

		tui.invalidate();

		assert.strictEqual(invalidated, true);
		tui.stop();
	});

	it("routes wheel input to the scroll view under the pointer", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const left = new ScrollView(new Text("a1\na2\na3\na4\na5\na6\na7", 0, 0), {
			follow: "end",
			primary: true,
		});
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4\nb5\nb6\nb7", 0, 0), { follow: "end" });
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 10, shrink: 0 },
				{ component: right, basis: 10, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;15;1M");
		await terminal.waitForRender();
		assert.strictEqual(left.scrollTop, 3);
		assert.strictEqual(right.scrollTop, 2);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a4        b3", "a5        b4", "a6        b5", "a7        b6"],
		);
		tui.stop();
	});

	it("uses button-motion tracking inside terminal multiplexers", () => {
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			for (const key of environmentKeys) delete process.env[key];
			process.env.TERM = "xterm-256color";
			const directTerminal = new RecordingTerminal();
			const directTui = new TuiAltScreen(directTerminal);
			directTui.start();
			const directWrites = directTerminal.events
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(directWrites.includes("\x1b[?1003h"));
			directTui.stop();

			const multiplexers = [
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				{ name: "Screen environment", environment: { STY: "123.session" } },
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			for (const { name, environment } of multiplexers) {
				for (const key of environmentKeys) delete process.env[key];
				for (const [key, value] of Object.entries(environment)) process.env[key] = value;
				const terminal = new RecordingTerminal();
				const tui = new TuiAltScreen(terminal);
				tui.start();
				const writes = terminal.events
					.filter((event): event is { type: "write"; data: string } => event.type === "write")
					.map((event) => event.data)
					.join("");
				assert.ok(writes.includes("\x1b[?1002h"), `${name} should enable button-motion tracking`);
				assert.ok(!writes.includes("\x1b[?1003h"), `${name} should not enable all-motion tracking`);
				assert.ok(writes.includes("\x1b[?1006h"), `${name} should enable SGR mouse encoding`);
				tui.stop();
			}
		} finally {
			for (const key of environmentKeys) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("invokes the right-click paste handler only on Windows", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		assert.ok(platformDescriptor);
		const terminal = new VirtualTerminal();
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			tui.start();
			terminal.sendInput("\x1b[<2;1;1M");
			terminal.sendInput("\x1b[<2;1;1m");
			assert.strictEqual(pasteCount, 1);

			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("drags a visible scrollbar thumb and keeps it visible until release", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{
				primary: true,
				scrollbar: "auto",
				scrollbarHideDelayMs: 50,
			},
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		terminal.sendInput("\x1b[<65;10;1M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isScrollbarVisible, true);

		terminal.sendInput("\x1b[<0;10;1M");
		await terminal.waitForRender();
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.strictEqual(scrollView.isScrollbarVisible, true);

		terminal.sendInput("\x1b[<32;10;4M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 15);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 16", "line 17", "line 18", "line 19", "line 20"],
		);

		terminal.sendInput("\x1b[<0;10;4m");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		terminal.sendInput("\x1b[<35;9;4M");
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 14);
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		terminal.sendInput("\x1b[<35;9;5M");
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("keeps the scrollbar column selectable while the thumb is hidden", async () => {
		const terminal = new RecordingTerminal(10, 2);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(new Text("123456789A\nabcdefghij\nmore\nlines", 0, 0), {
			scrollbar: "auto",
		});
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<32;10;2M");
		terminal.sendInput("\x1b[<0;10;2m");
		await terminal.waitForRender();

		const expected = `\x1b]52;c;${Buffer.from("A\nabcdefghij").toString("base64")}\x07`;
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes(expected)),
			JSON.stringify(terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;"))),
		);
		tui.stop();
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 3);
		assert.strictEqual(outer.scrollTop, 0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 4);
		assert.strictEqual(outer.scrollTop, 2);
		tui.stop();
	});

	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1bOF");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		tui.stop();
	});

	it("scrolls the transcript by half a page with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 15);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("routes Ctrl-modified viewport navigation to the focused component", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, []);

		const modifiedInputs = ["\x1b[1;5H", "\x1b[1;5F", "\x1b[5;5~", "\x1b[6;5~", "\x1b[57423;5u"];
		for (const input of modifiedInputs) terminal.sendInput(input);
		terminal.sendInput("\x1b[57423;5:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, modifiedInputs);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 1);
		assert.deepStrictEqual(editorInputs, modifiedInputs);

		tui.stop();
	});

	it("jumps between OSC 133 semantic prompt markers", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);

		terminal.sendInput("\x1b[57419;6u");
		terminal.sendInput("\x1b[57419;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 2);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 2");

		terminal.sendInput("\x1b[57420;6u");
		terminal.sendInput("\x1b[57420;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), "message 4");
		assert.strictEqual(tui.isFollowingOutput, true);

		tui.stop();
	});

	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			tui.addChild({
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				invalidate: () => {},
			});
			tui.addChild(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ filename: "example.png" },
					{ widthPx: 10, heightPx: 10 },
				),
			);
			tui.start();
			await terminal.waitForRender();
			tui.stop();
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")));
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:")));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			tui.addChild({
				render: () => [imageLine, "", "", "after", "more", "end"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			tui.scrollBy(1);
			await terminal.waitForRender();
			assert.ok(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("crops a Kitty image whose first line is above the viewport", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const imageId = 123;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		tui.addChild({
			render: () => ["before", imageLine, "", "", "after", "end"],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 3);
		assert.ok(
			terminal.events.some(
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		tui.stop();
	});

	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const label = new Text("left", 0, 0);
			const image = new Image(
				"A".repeat(8192),
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const header = new Text("header", 0, 0);
			const row = new HStack([
				{ component: label, basis: 10 },
				{ component: image, basis: 10 },
			]);
			tui.setLayoutRoot(
				new VStack([
					{ component: header, basis: "auto" },
					{ component: row, basis: 4 },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			label.setText("changed");
			header.setText("header\nsecond");
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			assert.ok(redrawWrites.length < 2000, `expected placement-only redraw, got ${redrawWrites.length} bytes`);
			assert.ok(terminal.getViewport().some((line) => line.trimEnd() === "changed"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 321;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => [imageLine, "after"],
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			tui.scrollBy(1);
			await terminal.waitForRender();
			tui.scrollBy(-1);
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=p,q=2"));
			assert.ok(!reentryWrites.includes("\x1b_Ga=T"));
			assert.ok(!reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 500;
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);

			const eventCount = terminal.events.length;
			tui.scrollToTop();
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=T"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 600;
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("opens an OSC 8 hyperlink on click but not on drag", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		const belUrl = "https://example.com/bel";
		const emojiUrl = "https://example.com/emoji";
		tui.addChild(
			new Text(
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl]);

		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		tui.stop();
	});

	it("selects visible text with the mouse and copies it with OSC 52", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(clipboardWrites),
		);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
			"selection inverse must be reapplied after a reset inside the selection",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("does not append whitespace to double-click word highlighting", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;3;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")));
		tui.stop();
	});

	it("highlights a complete whitespace segment during a word drag", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")));
		tui.stop();
	});

	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha)));

		// A double-click drag includes each word touched, rather than partial words.
		terminal.sendInput("\x1b[<0;12;1M");
		terminal.sendInput("\x1b[<0;12;1m");
		terminal.sendInput("\x1b[<0;14;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(words)));

		terminal.sendInput("\x1b[<0;7;2M");
		terminal.sendInput("\x1b[<0;7;2m");
		terminal.sendInput("\x1b[<0;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		terminal.sendInput("\x1b[<0;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(line)));

		tui.stop();
	});

	it("ignores orphan selection events and cancels an active selection on focus loss", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const clipboardWriteCount = () =>
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

		// A completed click leaves a zero-width anchor, but later orphaned drag/release events must not extend it.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);

		// Losing focus also cancels a press whose matching release never arrived.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")));

		tui.stop();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")));
	});

	it("stacks flash messages and collapses them as they expire", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.flash("First", 80);
		tui.flash("Second", 500);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" First "));
		assert.ok(viewport[1]?.endsWith(" Second "));

		await new Promise((resolve) => setTimeout(resolve, 100));
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" Second "));
		assert.ok(!viewport.some((line) => line.includes("First")));

		tui.stop();
	});

	it("auto-scrolls and extends a drag selection held at the viewport edge", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 6);

		terminal.sendInput("\x1b[<0;1;3M");
		terminal.sendInput("\x1b[<32;1;1M");
		await new Promise((resolve) => setTimeout(resolve, 130));
		await terminal.waitForRender();

		const selectionTop = tui.viewportTop;
		assert.ok(selectionTop < 6, `expected auto-scroll above row 6, got ${selectionTop}`);
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		const selectedLines = Array.from({ length: 8 - selectionTop }, (_, index) => `line ${selectionTop + index + 1}`);
		selectedLines.push("l");
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from(selectedLines.join("\n")).toString("base64")}\x07`;
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;"))),
		);
		tui.stop();
	});

	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			1,
		);

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			2,
		);

		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)));

		tui.stop();
	});

	it("ignores horizontal trackpad wheel events", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<66;1;1M");
		terminal.sendInput("\x1b[<67;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8"],
		);

		tui.stop();
	});

	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		const altScreenEnterIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		const mouseDisableIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		const mainScreenRestoreIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		assert.ok(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex);
		assert.ok(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex);
		assert.ok(mainScreenRestoreIndex > stopIndex);

		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		assert.strictEqual(restoreEvent?.type, "write");
		if (restoreEvent?.type === "write") {
			assert.ok(restoreEvent.data.includes("first"));
			assert.ok(restoreEvent.data.includes("second"));
			assert.ok(restoreEvent.data.includes("third"));
			assert.ok(restoreEvent.data.includes("fourth"));
			assert.ok(restoreEvent.data.includes("fifth"));
			assert.ok(restoreEvent.data.includes("sixth"));
			assert.ok(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth"));
		}
	});
});
