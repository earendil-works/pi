// Spike diagnostics: with P2MAC_DIAG_DIR set, every finished page load writes what the page sees (`page-N.json`) and
// snapshots of the webview (`page-N.png`) and of the whole window, tab bar included (`window-N.png`), there a few
// seconds later, so a run can be checked without a screen. P2MAC_DIAG_BRIDGE drives the host bridge (HostBridge.swift)
// once, from the first page.
import AppKit
import WebKit

@MainActor
enum Diagnostics {
	private static let directory = ProcessInfo.processInfo.environment["P2MAC_DIAG_DIR"].map { URL(fileURLWithPath: $0) }
	private static var count = 0

	private static let probe = """
		(() => ({
			url: location.href,
			title: document.title,
			text: document.body ? document.body.innerText.slice(0, 600) : null,
			notification: typeof Notification === "function" ? Notification.permission : "none",
			serviceWorker: "serviceWorker" in navigator,
			clipboard: !!(navigator.clipboard && navigator.clipboard.writeText),
			getUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
			userAgent: navigator.userAgent,
			shell: document.documentElement.dataset.shell ?? null,
			inset: getComputedStyle(document.documentElement).getPropertyValue("--shell-inset-start"),
			sidebarPadding: (() => { const e = document.querySelector(".sidebar-root .drawer-top"); return e ? getComputedStyle(e).paddingLeft : null; })(),
			theme: document.documentElement.dataset.theme ?? null,
			colorScheme: document.documentElement.dataset.colorScheme ?? null,
			prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
			piHost: !!window.webkit?.messageHandlers?.piHost,
		}))()
		"""

	// Which bars carry the corner mark, then the same with a full-window viewer layer (p2's own classes) on top.
	private static let cornerProbe = """
		const marked = () => [...document.querySelectorAll("[data-shell-corner]")].map((e) => `${e.className} ${getComputedStyle(e).paddingLeft}`);
		const stack = document.elementsFromPoint(2, 26).map((e) => { const r = e.getBoundingClientRect(); return `${e.tagName}.${e.className} ${r.left},${r.top} ${r.width}x${r.height}`; });
		const before = marked();
		const layer = document.createElement("div");
		layer.className = "viewer-layer";
		layer.innerHTML = '<div class="viewer-panel"><div class="viewer-head"><div><strong>Probe</strong></div></div></div>';
		document.body.append(layer);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const withViewer = marked();
		layer.remove();
		await new Promise((resolve) => setTimeout(resolve, 300));
		return { stack, before, withViewer, after: marked() };
		"""

	/// What receives a click in the title bar strip, the strip's height, and the page's interactive rectangles there.
	private static func chrome(_ controller: BrainPage) -> [String: Any] {
		guard let window = controller.webView.window, let frame = window.contentView?.superview else { return [:] }
		let height = window.frame.height
		var hits: [String: String] = [:]
		for (name, x) in [("left", 40.0), ("middle", window.frame.width / 2), ("right", window.frame.width - 30)] {
			let view = frame.hitTest(NSPoint(x: x, y: height - 26))
			hits[name] = view.map { String(describing: type(of: $0)) } ?? "nil"
		}
		return [
			"titlebar": height - window.contentLayoutRect.height,
			"hits": hits,
			"interactive": controller.webView.interactive.map { [$0.minX, $0.minY, $0.width, $0.height] },
		]
	}

	// The bridge from the page world: the preference, a change to `preference` and its event, then the refusals of an
	// invalid preference and of a frame inside the page.
	private static let bridgeProbe = """
		const host = window.webkit.messageHandlers.piHost;
		const call = async (message, target = host) => {
			try { return { reply: await target.postMessage(message) }; } catch (error) { return { error: String(error) }; }
		};
		const state = () => ({ theme: document.documentElement.dataset.theme ?? null, prefersDark: matchMedia("(prefers-color-scheme: dark)").matches });
		const events = [];
		addEventListener("pi-host-theme", (event) => events.push(event.detail));
		const before = { ...state(), get: await call({ type: "theme" }) };
		const set = await call({ type: "set-theme", preference });
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const after = { ...state(), get: await call({ type: "theme" }) };
		const invalid = await call({ type: "set-theme", preference: "sepia" });
		const unknown = await call({ type: "launch" });
		const frame = document.createElement("iframe");
		frame.srcdoc = "<p>probe</p>";
		await new Promise((resolve) => { frame.onload = resolve; document.body.append(frame); });
		const fromFrame = await call({ type: "set-theme", preference: "light" }, frame.contentWindow.webkit.messageHandlers.piHost);
		frame.remove();
		return { before, set, after, events, invalid, unknown, fromFrame };
		"""

	// A main frame on an origin the brain does not own, with the page's configuration (and so its bridge).
	private static let foreignProbe = """
		const host = window.webkit?.messageHandlers?.piHost;
		if (!host) return { piHost: false };
		try { return { piHost: true, origin: location.origin, reply: await host.postMessage({ type: "set-theme", preference: "light" }) }; }
		catch (error) { return { piHost: true, origin: location.origin, error: String(error) }; }
		"""

	private static var bridgePreference = ProcessInfo.processInfo.environment["P2MAC_DIAG_BRIDGE"]

	/// Drives the bridge of `controller`'s page with P2MAC_DIAG_BRIDGE=<preference>: writes `bridge-N.json` and the
	/// snapshots after the change (`page-N-bridge.png`, `window-N-bridge.png`), picks System in View > Appearance,
	/// clicks p2's theme button, grabs the window during two fades, then reloads the page over a stale stored theme
	/// (removed after the reload's record).
	private static func probeBridge(_ controller: BrainPage, preference: String, index: Int, in directory: URL) async {
		let webView = controller.webView
		var record: [String: Any] = [:]
		record["page"] = try? await webView.callAsyncJavaScript(bridgeProbe, arguments: ["preference": preference], contentWorld: .page)
		record["appAppearance"] = NSApp.effectiveAppearance.name.rawValue
		let foreign = WKWebView(frame: NSRect(x: 0, y: 0, width: 200, height: 200), configuration: webView.configuration)
		foreign.loadHTMLString("<p>foreign</p>", baseURL: URL(string: "https://foreign.invalid/"))
		let deadline = Date().addingTimeInterval(5)
		while foreign.isLoading || foreign.url == nil, Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
		record["foreign"] = try? await foreign.callAsyncJavaScript(foreignProbe, contentWorld: .page)
		record["appAppearanceAfterRefusals"] = NSApp.effectiveAppearance.name.rawValue
		await snapshot(controller, name: "\(index)-bridge", in: directory)
		// The other windows too: one may show a placeholder, which has no page load to record it.
		for (number, window) in NSApp.windows.filter({ $0.delegate is PiWindowController && $0 !== controller.webView.window }).enumerated() {
			snapshot(window, to: directory.appending(path: "window-\(index)-bridge-other-\(number + 1).png"))
		}
		record["menu"] = await probeMenu(webView)
		record["switch"] = await probeSwitch(webView)
		record["fade"] = await probeFade(controller, index: index, in: directory)
		write(record, to: directory.appending(path: "bridge-\(index).json"))
		// A stale forced value in the page's own storage, the opposite of what it shows: the reload (page-N+1.json)
		// must ignore it. That record removes it again, so the run leaves no state in the brain's data store.
		_ = try? await webView.evaluateJavaScript(
			"localStorage.setItem('pi-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')")
		staleTheme = true
		webView.reload()
	}

	/// The stale stored theme is in the page's storage until the reload's record removes it.
	private static var staleTheme = false

	// p2's own theme button (theme.ts's native backend): `clicks` clicks `gap` ms apart ask the app, whose appearance
	// must follow; the page and the app must agree once the answers are in.
	private static let switchProbe = """
		const button = document.querySelector(".theme-toggle");
		if (!button) return { button: false };
		const before = button.title;
		for (let i = 0; i < clicks; i++) {
			if (i > 0) await new Promise((resolve) => setTimeout(resolve, gap));
			button.click();
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
		return { clicks, before, after: button.title, theme: document.documentElement.dataset.theme, prefersDark: matchMedia("(prefers-color-scheme: dark)").matches };
		"""

	/// Clicks p2's theme button twice, then double-clicks it (50 ms apart), and records the page and the app's
	/// preference after each.
	private static func probeSwitch(_ webView: WKWebView) async -> [[String: Any]] {
		var results: [[String: Any]] = []
		for clicks in [1, 1, 2] {
			let arguments: [String: Any] = ["clicks": clicks, "gap": 50]
			var result = (try? await webView.callAsyncJavaScript(switchProbe, arguments: arguments, contentWorld: .page)) as? [String: Any] ?? [:]
			result["appPreference"] = (NSApp.delegate as? AppDelegate)?.appearance.rawValue
			result["appAppearance"] = NSApp.appearance?.name.rawValue ?? "nil (system)"
			results.append(result)
		}
		return results
	}

	// Logs in epoch milliseconds (the app's clock too) the page's view transitions (when called, when their DOM change
	// ran, ready, finished), theme events, `data-theme` writes and scheme media changes; returns what the engine supports.
	private static let fadeHook = """
		const now = () => performance.timeOrigin + performance.now();
		const log = window.piDiagFade = { transitions: [], events: [], themeWrites: [], mediaChanges: [] };
		const start = document.startViewTransition?.bind(document);
		if (start) document.startViewTransition = (argument) => {
			const entry = { called: now(), form: typeof argument === "function" ? "function" : "object", types: argument?.types ?? null };
			log.transitions.push(entry);
			// When the DOM change runs: after the old state was captured.
			const update = typeof argument === "function" ? argument : argument.update;
			const wrapped = () => { entry.update = now(); return update(); };
			const transition = start(typeof argument === "function" ? wrapped : { ...argument, update: wrapped });
			transition.ready.then(() => { entry.ready = now(); }, (error) => { entry.readyError = String(error); });
			transition.finished.then(() => { entry.finished = now(); });
			return transition;
		};
		addEventListener("pi-host-theme", (event) => log.events.push({ at: now(), preference: event.detail?.preference }));
		new MutationObserver(() => log.themeWrites.push({ at: now(), theme: document.documentElement.dataset.theme }))
			.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => log.mediaChanges.push({ at: now(), dark: event.matches }));
		// A clock in the page, so a grab shows when it was taken (ms since the trigger; the page paints a frame late).
		const clock = document.createElement("div");
		clock.style.cssText = "position:fixed;right:24px;bottom:120px;z-index:2147483647;font:600 40px ui-monospace,monospace;padding:4px 12px;background:#e33;color:#fff;pointer-events:none";
		document.body.append(clock);
		const tick = () => { clock.textContent = log.posted ? `${Math.round(now() - log.posted)} ms` : "-"; requestAnimationFrame(tick); };
		tick();
		return {
			startViewTransition: typeof start === "function",
			types: typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype,
			typeSelector: CSS.supports("selector(:active-view-transition-type(pi-theme))"),
			reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
			visibility: document.visibilityState,
		};
		"""

	// The triggers, after the switch probe left the page on Light: p2's own button (the page fades at once,
	// optimistically) and the app's change through the bridge (the page fades on the event), each way.
	private static let fadeTriggers: [(name: String, script: String)] = {
		let mark = "window.piDiagFade.posted = performance.timeOrigin + performance.now(); "
		let click = mark + "document.querySelector('.theme-toggle').click()"
		let bridge = { (preference: String) in
			mark + "window.webkit.messageHandlers.piHost.postMessage({ type: 'set-theme', preference: '\(preference)' })"
		}
		return [("button-to-dark", click), ("bridge-to-light", bridge("light")), ("bridge-to-dark", bridge("dark")), ("button-to-system", click)]
	}()

	/// Changes the theme with each of `fadeTriggers` and grabs the windows with `screencapture` 0, 80, 160 and
	/// 300 ms after each (`fade-N-<trigger>-<ms>[-other-K].png`). Records when each grab was launched, when the page's view
	/// transitions ran, and when the `pi-host-theme` event arrived, which the app sends right after it starts its
	/// native fade; all in epoch milliseconds.
	private static func probeFade(_ controller: BrainPage, index: Int, in directory: URL) async -> [String: Any] {
		let webView = controller.webView
		guard let window = webView.window else { return [:] }
		// An occluded page is hidden to WebKit: it paints nothing and p2 skips its fade. A run started from a terminal
		// is not the active app, so the window goes in front of other apps' windows without activating.
		window.orderFrontRegardless()
		try? await Task.sleep(for: .milliseconds(500))
		let others = NSApp.windows.filter { $0.delegate is PiWindowController && $0 !== window && $0.isVisible }
		let tabBar = window.contentView?.subviews.first { $0 is BrainTabBar }
		var record: [String: Any] = ["support": (try? await webView.callAsyncJavaScript(fadeHook, contentWorld: .page)) ?? NSNull()]
		let epoch = { Date().timeIntervalSince1970 * 1000 }
		for trigger in fadeTriggers {
			_ = try? await webView.callAsyncJavaScript("window.piDiagFade.transitions = []; window.piDiagFade.events = []", contentWorld: .page)
			let start = epoch()
			webView.evaluateJavaScript(trigger.script, in: nil, in: .page)
			var grabs: [[String: Any]] = []
			for offset in [0, 80, 160, 300] {
				let wait = start + Double(offset) - epoch()
				if wait > 0 { try? await Task.sleep(for: .milliseconds(Int(wait))) }
				let launched = epoch()
				for (number, grabbed) in ([window] + others).enumerated() {
					let name = "fade-\(index)-\(trigger.name)-\(offset)\(number == 0 ? "" : "-other-\(number)").png"
					_ = try? Process.run(
						URL(fileURLWithPath: "/usr/sbin/screencapture"),
						arguments: ["-x", "-o", "-l", "\(grabbed.windowNumber)", directory.appending(path: name).path])
				}
				grabs.append(["offset": offset, "launched": launched - start])
			}
			let fading = tabBar?.layer?.animationKeys() ?? []
			try? await Task.sleep(for: .milliseconds(700))
			let page = try? await webView.callAsyncJavaScript("return window.piDiagFade", contentWorld: .page)
			record[trigger.name] = [
				"start": start, "grabs": grabs, "page": page ?? NSNull(), "appPreference": controller.app.appearance.rawValue,
				"tabBarAnimationsAt300": fading, "tabBarAnimationsAt1000": tabBar?.layer?.animationKeys() ?? [],
			]
		}
		return record
	}

	/// View > Appearance: its checkmark after the page's change, then the change it makes itself (System) and the event
	/// the page gets.
	private static func probeMenu(_ webView: WKWebView) async -> [String: Any] {
		let menu = NSApp.mainMenu?.item(withTitle: "View")?.submenu?.item(withTitle: "Appearance")?.submenu
		let checked = { () -> [String] in
			menu?.update()
			return menu?.items.filter { $0.state == .on }.map(\.title) ?? []
		}
		var record: [String: Any] = ["checked": checked()]
		_ = try? await webView.evaluateJavaScript(
			"window.piDiagEvents = []; addEventListener('pi-host-theme', (event) => window.piDiagEvents.push(event.detail))")
		if let menu, let system = menu.items.firstIndex(where: { $0.title == "System" }) { menu.performActionForItem(at: system) }
		try? await Task.sleep(for: .milliseconds(500))
		record["checkedAfterSystem"] = checked()
		record["appAppearanceAfterSystem"] = NSApp.appearance?.name.rawValue ?? "nil (system)"
		record["eventsAfterSystem"] = try? await webView.evaluateJavaScript("window.piDiagEvents")
		return record
	}

	/// Writes the webview's snapshot (`page-<name>.png`) and the whole window's (`window-<name>.png`).
	private static func snapshot(_ controller: BrainPage, name: String, in directory: URL) async {
		if let image = try? await controller.webView.takeSnapshot(configuration: nil), let tiff = image.tiffRepresentation {
			writePNG(NSBitmapImageRep(data: tiff), to: directory.appending(path: "page-\(name).png"))
		}
		if let window = controller.webView.window { snapshot(window, to: directory.appending(path: "window-\(name).png")) }
	}

	// The window's content as AppKit draws it: the tab bar and the placeholder. The webview's remote layer is not
	// always captured (a blank page area); `page-N.png` is the page's own snapshot.
	private static func snapshot(_ window: NSWindow, to file: URL) {
		guard let view = window.contentView, let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
		view.cacheDisplay(in: view.bounds, to: bitmap)
		writePNG(bitmap, to: file)
	}

	private static func writePNG(_ bitmap: NSBitmapImageRep?, to file: URL) {
		try? bitmap?.representation(using: .png, properties: [:])?.write(to: file)
	}

	private static func write(_ record: [String: Any], to file: URL) {
		if let data = try? JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys]) {
			try? data.write(to: file)
		}
	}

	private static var toOpen = (ProcessInfo.processInfo.environment["P2MAC_DIAG_OPEN"] ?? "").split(separator: ",").map(String.init)

	/// Records the page of `controller` once it has had time to boot and connect. With P2MAC_DIAG_OPEN=<brain IDs>
	/// (comma-separated; P2MAC_DIAG_PATH for the address), each page load opens a window on the next of them a few
	/// seconds later, standing in for clicks on their tabs.
	static func pageFinished(_ controller: BrainPage) {
		guard let directory else { return }
		if !toOpen.isEmpty {
			let id = toOpen.removeFirst()
			let app = controller.app
			DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
				app.openWindow(id, path: ProcessInfo.processInfo.environment["P2MAC_DIAG_PATH"] ?? "/")
			}
		}
		count += 1
		let index = count
		DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
			Task { @MainActor in
				try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
				let webView = controller.webView
				let value = try? await webView.evaluateJavaScript(probe)
				var record = (value as? [String: Any]) ?? [:]
				record["chrome"] = chrome(controller)
				record["corner"] = try? await webView.callAsyncJavaScript(cornerProbe, contentWorld: .page)
				record["appAppearance"] = NSApp.effectiveAppearance.name.rawValue
				write(record, to: directory.appending(path: "page-\(index).json"))
				if staleTheme {
					staleTheme = false
					_ = try? await webView.evaluateJavaScript("localStorage.removeItem('pi-theme')")
				}
				await snapshot(controller, name: "\(index)", in: directory)
				if let preference = bridgePreference, record["piHost"] as? Bool == true {
					bridgePreference = nil
					await probeBridge(controller, preference: preference, index: index, in: directory)
				}
			}
		}
	}
}
