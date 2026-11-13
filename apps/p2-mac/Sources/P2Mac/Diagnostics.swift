// Spike diagnostics: with P2MAC_DIAG_DIR set, every finished page load writes what the page sees (`page-N.json`) and
// a snapshot of the webview (`page-N.png`) there a few seconds later, so a run can be checked without a screen.
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
				if let data = try? JSONSerialization.data(withJSONObject: record, options: [.prettyPrinted, .sortedKeys]) {
					try? data.write(to: directory.appending(path: "page-\(index).json"))
				}
				if let image = try? await webView.takeSnapshot(configuration: nil),
					let tiff = image.tiffRepresentation,
					let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
				{
					try? png.write(to: directory.appending(path: "page-\(index).png"))
				}
			}
		}
	}
}
