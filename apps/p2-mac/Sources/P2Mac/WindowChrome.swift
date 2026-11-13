// The window's chrome drawn inside the page, for windows without a tab bar (not signed in to Radius): the webview
// fills the whole window under a transparent title bar, so p2's own bars are the title bar and its background runs to
// the top edge. With a tab bar (BrainTabBar.swift) the bar is the title bar and pages start below it.
//
// Three parts make that work:
// - Inset. The window buttons sit over the page's top-left corner. Which bar is there depends on the layout: the
//   sidebar header, the top bar, a full-window viewer or workspace, a plugin's pane. So the page script finds them by
//   geometry (bars stacked at the corner) and marks them `data-shell-corner`, and p2's CSS starts a marked bar's
//   content after `--shell-inset-start`, the buttons' width, set on `<html data-shell="macos">`. In full screen the
//   buttons are hidden and nothing is marked.
// - Dragging. WebKit has no `app-region`, and a webview under the title bar swallows its mouse events. So a script in
//   its own content world reports where the interactive elements in the title bar strip are (links, buttons,
//   inputs). A mouse-down anywhere else in the strip drags the window natively, and a double click does what
//   the title bar's would (TitleBarDoubleClick.swift).
// - Height. An empty unified toolbar gives the window the buttons and title bar of a window with a toolbar (larger
//   buttons, centred 26 points from the top: the middle of p2's 52-pixel `--bar`). The title bar itself is taller than
//   p2's bars, so dragging is limited to their height.
import AppKit
import WebKit

/// A webview that drags its window from the parts of the title bar strip the page leaves free.
final class ChromeWebView: WKWebView {
	/// Interactive rectangles in the strip, in CSS pixels from the page's top left, as the page last reported them.
	var interactive: [CGRect] = []
	/// The page is the window's top edge (no tab bar above it).
	var dragsWindow = false

	override func mouseDown(with event: NSEvent) {
		guard dragsWindow, let window, !window.styleMask.contains(.fullScreen), inDragStrip(event) else {
			return super.mouseDown(with: event)
		}
		if event.clickCount == 2 {
			window.titleBarDoubleClicked(event)
		} else {
			window.performDrag(with: event)
		}
	}

	/// p2's `--bar`: the height of its top bars, which act as the title bar.
	static let barHeight: CGFloat = 52

	private func inDragStrip(_ event: NSEvent) -> Bool {
		let strip = Self.barHeight * pageZoom * magnification
		let local = convert(event.locationInWindow, from: nil)
		let top = isFlipped ? local.y : bounds.height - local.y
		guard top < strip else { return false }
		let scale = pageZoom * magnification
		let point = CGPoint(x: local.x / scale, y: top / scale)
		return !interactive.contains { $0.insetBy(dx: -2, dy: -2).contains(point) }
	}
}

/// The page side: marks the document as shown in the app and reports the strip's interactive elements.
enum ChromeScript {
	static let world = WKContentWorld.world(name: "pi-chrome")
	static let handler = "piChrome"

	/// Installs the script and its message handler in `controller`; `receive` gets the reported rectangles.
	static func install(in controller: WKUserContentController, receive: @escaping ([CGRect]) -> Void) {
		controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
		controller.add(Receiver(receive), contentWorld: world, name: handler)
	}

	/// Sets the width the window buttons take (0: none) and marks the bars at the corner again.
	static func setInset(_ inset: CGFloat, in webView: WKWebView) {
		webView.evaluateJavaScript("window.piChromeInset(\(Int(inset)))", in: nil, in: world)
	}

	// Samples the strip with elementFromPoint (cheap, and independent of p2's markup) rather than walking the DOM:
	// a 12px grid on three lines finds every control at least 12px wide. Throttled, and posted only on change.
	private static let source = """
		(() => {
			const root = document.documentElement;
			root.dataset.shell = "macos";
			let inset = 80;
			root.style.setProperty("--shell-inset-start", `${inset}px`);
			const STRIP = 52, STEP = 12;

			// The bars at the window's top-left corner: every element stacked at a point in the buttons' row that
			// starts at the corner and is bar-sized, the outermost of nested ones. All of them, not only the topmost,
			// so a bar under a scrim or a dialog keeps its place. The marks change no geometry these tests read.
			const isBar = (element) => {
				const r = element.getBoundingClientRect();
				return r.left <= 1 && r.top <= 1 && r.height >= 24 && r.height <= 80 && r.width >= 120;
			};
			const markCorner = () => {
				const bars = inset > 0 ? document.elementsFromPoint(2, 26).filter(isBar) : [];
				const outer = bars.filter((bar) => !bars.some((other) => other !== bar && other.contains(bar)));
				for (const marked of document.querySelectorAll("[data-shell-corner]")) {
					if (!outer.includes(marked)) marked.removeAttribute("data-shell-corner");
				}
				for (const bar of outer) bar.setAttribute("data-shell-corner", "");
			};
			// In the frame's animation callbacks: after the change that moved a bar, before it is painted. WebKit
			// pauses those in a hidden window, so a timer stands in there.
			let frame = 0, fallback = 0;
			const runMark = () => {
				cancelAnimationFrame(frame);
				clearTimeout(fallback);
				frame = 0;
				markCorner();
			};
			const scheduleMark = () => {
				if (frame) return;
				frame = requestAnimationFrame(runMark);
				fallback = setTimeout(runMark, 100);
			};
			window.piChromeInset = (value) => {
				inset = value;
				root.style.setProperty("--shell-inset-start", `${value}px`);
				markCorner();
			};
			const INTERACTIVE = 'a[href], button, input, textarea, select, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="slider"], [contenteditable=""], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), iframe, video, audio';
			let last = "", timer = 0;
			const report = () => {
				timer = 0;
				const found = new Set();
				for (const y of [10, 26, 42]) {
					for (let x = 2; x < innerWidth; x += STEP) {
						const hit = document.elementFromPoint(x, y)?.closest(INTERACTIVE);
						if (hit) found.add(hit);
					}
				}
				const rects = [...found].map((element) => {
					const r = element.getBoundingClientRect();
					return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
				});
				const text = JSON.stringify(rects);
				if (text === last) return;
				last = text;
				window.webkit.messageHandlers.\(handler).postMessage(rects);
			};
			const schedule = () => {
				scheduleMark();
				if (!timer) timer = setTimeout(report, 120);
			};
			addEventListener("resize", schedule);
			addEventListener("transitionend", schedule, true);
			addEventListener("DOMContentLoaded", () => {
				new MutationObserver(schedule).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "disabled"] });
				schedule();
			});
		})();
		"""

	/// Holds the callback weakly for WebKit, which retains its message handlers.
	private final class Receiver: NSObject, WKScriptMessageHandler {
		let receive: ([CGRect]) -> Void

		init(_ receive: @escaping ([CGRect]) -> Void) { self.receive = receive }

		func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
			guard message.frameInfo.isMainFrame, let list = message.body as? [[Double]] else { return }
			receive(list.compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil })
		}
	}
}
