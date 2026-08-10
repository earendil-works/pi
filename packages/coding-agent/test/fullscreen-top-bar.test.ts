import { type Component, ScrollView, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FullscreenTopBar } from "../src/modes/interactive/components/fullscreen-top-bar.ts";
import { buildInteractiveLayouts } from "../src/modes/interactive/components/interactive-layout.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createSession(options: {
	cwd?: string;
	contextWindow?: number;
	contextPercent?: number | null;
	contextUsageUndefined?: boolean;
}): AgentSession {
	const contextWindow = options.contextWindow ?? 272_000;
	const session = {
		state: {
			model: {
				id: "test-model",
				provider: "test",
				contextWindow,
			},
		},
		sessionManager: {
			getCwd: () => options.cwd ?? "/home/user/project",
		},
		getContextUsage: () => {
			if (options.contextUsageUndefined) return undefined;
			const percent = options.contextPercent === undefined ? 50.9 : options.contextPercent;
			return {
				tokens: percent === null ? null : Math.round((percent / 100) * contextWindow),
				contextWindow,
				percent,
			};
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(branch: string | null): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

/** Default right-side context label for createSession({}) with auto-compact on. */
const DEFAULT_RIGHT_LABEL = "50.9%/272k (auto)";

function findBox(
	root: { component: Component; children: unknown[] },
	target: Component,
):
	| { rect: { x: number; y: number; width: number; height: number }; component: Component; children: unknown[] }
	| undefined {
	type Box = { component: Component; children: Box[]; rect: { x: number; y: number; width: number; height: number } };
	const visit = (box: Box): Box | undefined => {
		if (box.component === target) return box;
		for (const child of box.children) {
			const match = visit(child);
			if (match) return match;
		}
		return undefined;
	};
	return visit(root as Box);
}

describe("FullscreenTopBar", () => {
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	beforeAll(() => {
		initTheme(undefined, false);
	});

	beforeEach(() => {
		process.env.HOME = "/home/user";
		delete process.env.USERPROFILE;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = originalUserProfile;
		}
	});

	it("renders cwd abbreviated with branch and context usage on one line", () => {
		const bar = new FullscreenTopBar(createSession({}), createFooterData("main"));
		const lines = bar.render(80);
		expect(lines).toHaveLength(1);
		const plain = stripAnsi(lines[0]);
		expect(plain).toContain("~/project (main)");
		expect(plain).toContain(DEFAULT_RIGHT_LABEL);
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(80);
	});

	it("omits branch when unavailable", () => {
		const bar = new FullscreenTopBar(createSession({}), createFooterData(null));
		const plain = stripAnsi(bar.render(80)[0]);
		expect(plain).toContain("~/project");
		expect(plain).not.toContain("(main)");
		expect(plain).toContain(DEFAULT_RIGHT_LABEL);
	});

	it("shows unknown context percent as ?", () => {
		const bar = new FullscreenTopBar(createSession({ contextPercent: null }), createFooterData("main"));
		bar.setAutoCompactEnabled(true);
		const plain = stripAnsi(bar.render(80)[0]);
		expect(plain).toContain("?/272k (auto)");
	});

	it("hides auto indicator when auto-compact is disabled", () => {
		const bar = new FullscreenTopBar(createSession({}), createFooterData(null));
		bar.setAutoCompactEnabled(false);
		const plain = stripAnsi(bar.render(80)[0]);
		expect(plain).toContain("50.9%/272k");
		expect(plain).not.toContain("(auto)");
	});

	it("falls back to model contextWindow when getContextUsage is undefined", () => {
		const bar = new FullscreenTopBar(
			createSession({ contextWindow: 200_000, contextUsageUndefined: true }),
			createFooterData(null),
		);
		const plain = stripAnsi(bar.render(80)[0]);
		// Matches FooterComponent: undefined usage → percent treated as 0.0 with model window.
		expect(plain).toContain("0.0%/200k (auto)");
	});

	it("returns a single empty line when width is zero or negative", () => {
		const bar = new FullscreenTopBar(createSession({}), createFooterData("main"));
		expect(bar.render(0)).toEqual([""]);
		expect(bar.render(-1)).toEqual([""]);
		expect(bar.render(-40)).toEqual([""]);
	});

	it("shows right label only and fills exact width when width equals right-label width", () => {
		const bar = new FullscreenTopBar(createSession({}), createFooterData("main"));
		const rightWidth = visibleWidth(DEFAULT_RIGHT_LABEL);
		const lines = bar.render(rightWidth);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBe(rightWidth);
		expect(stripAnsi(lines[0])).toBe(DEFAULT_RIGHT_LABEL);
	});

	it("truncates right label with ellipsis and exact width when narrower than right label", () => {
		const bar = new FullscreenTopBar(createSession({}), createFooterData("main"));
		const rightWidth = visibleWidth(DEFAULT_RIGHT_LABEL);
		const width = rightWidth - 4;
		expect(width).toBeGreaterThan(0);
		const lines = bar.render(width);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBe(width);
		const plain = stripAnsi(lines[0]);
		expect(plain.endsWith("...")).toBe(true);
		expect(plain).not.toBe(DEFAULT_RIGHT_LABEL);
		expect(plain.length).toBeLessThan(DEFAULT_RIGHT_LABEL.length);
	});

	it("preserves right side at the right edge with exact total width under left pressure", () => {
		const bar = new FullscreenTopBar(
			createSession({ cwd: "/home/user/very/long/path/to/a/deep/project" }),
			createFooterData("feature/long-branch-name"),
		);
		const width = 36;
		const lines = bar.render(width);
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0])).toBe(width);
		const plain = stripAnsi(lines[0]);
		expect(plain.endsWith(DEFAULT_RIGHT_LABEL)).toBe(true);
		expect(plain.slice(plain.length - DEFAULT_RIGHT_LABEL.length)).toBe(DEFAULT_RIGHT_LABEL);
		// Left is truncated; full path/branch must not both fit.
		expect(plain).toContain("...");
		expect(plain).not.toContain("/home/user/very/long/path/to/a/deep/project");
	});

	it("keeps exactly one line within width across a range of widths", () => {
		const bar = new FullscreenTopBar(
			createSession({ cwd: "/home/user/project/with/nested/dirs" }),
			createFooterData("main"),
		);
		for (const width of [1, 5, 10, 15, 20, 30, 40, 80, 120]) {
			const lines = bar.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		}
	});

	it("applies warning color above 70% and error color above 90%", () => {
		const warningBar = new FullscreenTopBar(createSession({ contextPercent: 75.0 }), createFooterData(null));
		const errorBar = new FullscreenTopBar(createSession({ contextPercent: 95.0 }), createFooterData(null));
		const warningLine = warningBar.render(80)[0];
		const errorLine = errorBar.render(80)[0];
		// Colored lines contain ANSI; plain content still correct
		expect(stripAnsi(warningLine)).toContain("75.0%/272k (auto)");
		expect(stripAnsi(errorLine)).toContain("95.0%/272k (auto)");
		expect(warningLine).not.toBe(stripAnsi(warningLine));
		expect(errorLine).not.toBe(stripAnsi(errorLine));
		expect(warningLine).not.toEqual(errorLine);
	});

	it("updates after setSession and setAutoCompactEnabled", () => {
		const bar = new FullscreenTopBar(createSession({ contextPercent: 10 }), createFooterData(null));
		expect(stripAnsi(bar.render(80)[0])).toContain("10.0%/272k (auto)");

		bar.setSession(createSession({ contextPercent: 42.5, contextWindow: 128_000 }));
		bar.setAutoCompactEnabled(false);
		const plain = stripAnsi(bar.render(80)[0]);
		expect(plain).toContain("42.5%/128k");
		expect(plain).not.toContain("(auto)");
	});
});

describe("buildInteractiveLayouts", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	function createChromeParts() {
		const topBar = new FullscreenTopBar(createSession({}), createFooterData("main"));
		const document = new Text("doc", 0, 0);
		const transcriptLines = Array.from({ length: 40 }, (_, i) => `transcript-${i}`);
		const transcriptBody: Component = {
			render: () => transcriptLines,
			invalidate: () => {},
		};
		const transcriptScrollView = new ScrollView(transcriptBody, {
			follow: "end",
			primary: true,
			scrollbar: "hidden",
		});
		const pendingMessages = new Text("", 0, 0);
		const status = new Text("", 0, 0);
		const widgetAbove = new Text("", 0, 0);
		// Multi-line dock chrome so dock occupies a stable last band.
		const editor = new Text("editor-1\neditor-2\neditor-3", 0, 0);
		const widgetBelow = new Text("", 0, 0);
		const footer = new Text("footer", 0, 0);

		const layouts = buildInteractiveLayouts({
			topBar,
			transcriptScrollView,
			document,
			pendingMessages,
			status,
			widgetAbove,
			editor,
			widgetBelow,
			footer,
		});

		return {
			topBar,
			document,
			transcriptScrollView,
			transcriptLines,
			pendingMessages,
			status,
			widgetAbove,
			editor,
			widgetBelow,
			footer,
			layouts,
		};
	}

	it("regular mode mount children exclude the top bar; fullscreen root includes it", () => {
		const {
			topBar,
			document,
			transcriptScrollView,
			pendingMessages,
			status,
			widgetAbove,
			editor,
			widgetBelow,
			footer,
			layouts,
		} = createChromeParts();

		expect(layouts.regularModeMountChildren).toEqual([
			document,
			pendingMessages,
			status,
			widgetAbove,
			editor,
			widgetBelow,
			footer,
		]);
		expect(layouts.regularModeMountChildren).not.toContain(topBar);
		expect(layouts.regularModeMountChildren).not.toContain(transcriptScrollView);
		expect(layouts.regularModeMountChildren).not.toContain(layouts.dock);

		expect(layouts.fullscreenLayoutRoot.children).toEqual([topBar, transcriptScrollView, layouts.dock]);
		expect(layouts.fullscreenLayoutRoot.children[0]).toBe(topBar);
		expect(layouts.fullscreenLayoutRoot.children.at(-1)).toBe(layouts.dock);
	});

	it("places FullscreenTopBar at y=0 height=1 outside the transcript ScrollView and keeps it fixed across scroll and resize", () => {
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = "/home/user";
		delete process.env.USERPROFILE;

		try {
			const { topBar, transcriptScrollView, layouts } = createChromeParts();
			const root = layouts.fullscreenLayoutRoot;
			const dock = layouts.dock;

			const assertFixedTopBar = (width: number, height: number) => {
				const frame = renderLayoutFrame(root, width, height, () => {});
				expect(frame.root.children.map((child) => child.component)).toEqual([topBar, transcriptScrollView, dock]);

				const topBox = frame.root.children[0]!;
				expect(topBox.component).toBe(topBar);
				expect(topBox.rect).toEqual({ x: 0, y: 0, width, height: 1 });

				const scrollBox = frame.root.children[1]!;
				expect(scrollBox.component).toBe(transcriptScrollView);
				expect(scrollBox.rect.y).toBe(1);
				expect(scrollBox.rect.x).toBe(0);
				expect(scrollBox.rect.width).toBe(width);
				// Top bar is not nested inside the scroll view.
				expect(findBox(scrollBox, topBar)).toBeUndefined();

				const dockBox = frame.root.children[2]!;
				expect(dockBox.component).toBe(dock);
				expect(dockBox.rect.y).toBe(topBox.rect.height + scrollBox.rect.height);
				expect(frame.root.children.at(-1)?.component).toBe(dock);

				// Painted first row is the top bar content, not transcript.
				const paintedTop = stripAnsi(frame.lines[0] ?? "");
				expect(paintedTop).toContain("~/project (main)");
				expect(paintedTop).toContain(DEFAULT_RIGHT_LABEL);
				expect(paintedTop).not.toContain("transcript-");

				return frame;
			};

			// Initial frame
			const initial = assertFixedTopBar(80, 24);
			const initialScrollTop = transcriptScrollView.scrollTop;

			// Scroll away from follow-end; top bar geometry and paint stay fixed.
			transcriptScrollView.scrollTo(0);
			expect(transcriptScrollView.scrollTop).not.toBe(initialScrollTop);
			const scrolled = assertFixedTopBar(80, 24);
			expect(scrolled.root.children[0]!.rect).toEqual(initial.root.children[0]!.rect);
			// Transcript viewport content changed with scroll, but y=0 did not.
			const scrolledBody = (scrolled.lines.slice(1, 1 + scrolled.root.children[1]!.rect.height) ?? []).map((line) =>
				stripAnsi(line),
			);
			const initialBody = (initial.lines.slice(1, 1 + initial.root.children[1]!.rect.height) ?? []).map((line) =>
				stripAnsi(line),
			);
			expect(scrolledBody.some((line) => line.includes("transcript-0"))).toBe(true);
			expect(initialBody.some((line) => line.includes("transcript-0"))).toBe(false);
			expect(stripAnsi(scrolled.lines[0] ?? "")).toBe(stripAnsi(initial.lines[0] ?? ""));

			// Resize frames: top bar remains y=0,h=1; dock remains last.
			for (const [width, height] of [
				[40, 12],
				[100, 30],
				[60, 8],
			] as const) {
				const frame = assertFixedTopBar(width, height);
				expect(frame.root.children.at(-1)?.component).toBe(dock);
				expect(frame.root.children[0]!.rect.y).toBe(0);
				expect(frame.root.children[0]!.rect.height).toBe(1);
			}
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
			if (originalUserProfile === undefined) {
				delete process.env.USERPROFILE;
			} else {
				process.env.USERPROFILE = originalUserProfile;
			}
		}
	});
});
