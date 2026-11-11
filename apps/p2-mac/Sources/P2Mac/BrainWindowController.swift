// One window on a brain: a WKWebView with the brain's own cookie store, filling the window under a transparent title
// bar (WindowChrome.swift), with native link, download, file panel, dialog and permission handling, and a native
// placeholder while the server is not reachable.
import AppKit
import WebKit

@MainActor
final class BrainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
	WKDownloadDelegate
{
	let brain: Brain
	let webView: ChromeWebView
	private unowned let app: AppDelegate
	private let placeholder = Placeholder()
	private var path: String
	private var loaded = false
	private var connecting = false

	init(brain: Brain, path: String, app: AppDelegate) {
		self.brain = brain
		self.path = path
		self.app = app
		let configuration = WKWebViewConfiguration()
		configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: brain.dataStoreID)
		configuration.applicationNameForUserAgent = "PiMac/0.0.1"
		configuration.preferences.isElementFullscreenEnabled = true
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
		configuration.mediaTypesRequiringUserActionForPlayback = []
		webView = ChromeWebView(frame: .zero, configuration: configuration)
		webView.isInspectable = true
		webView.allowsBackForwardNavigationGestures = true
		webView.allowsMagnification = true

		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
			styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		window.title = brain.title
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		let toolbar = NSToolbar(identifier: "pi-window")
		toolbar.showsBaselineSeparator = false
		window.toolbar = toolbar
		window.toolbarStyle = .unified
		// Native tabs would put a tab bar over the page's own bars: new windows instead.
		window.tabbingMode = .disallowed
		window.minSize = NSSize(width: 420, height: 360)
		window.isReleasedWhenClosed = false
		super.init(window: window)
		window.delegate = self
		ChromeScript.install(in: configuration.userContentController) { [weak webView] rects in
			webView?.interactive = rects
		}

		let content = NSView()
		for view in [webView, placeholder] as [NSView] {
			view.translatesAutoresizingMaskIntoConstraints = false
			content.addSubview(view)
			NSLayoutConstraint.activate([
				view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
				view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
				view.topAnchor.constraint(equalTo: content.topAnchor),
				view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
			])
		}
		window.contentView = content
		webView.navigationDelegate = self
		webView.uiDelegate = self
		placeholder.onAction = { [weak self] in self?.placeholderAction() }
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) { fatalError("not used") }

	/// Follows the server: connects once it runs, shows why not otherwise.
	func serverChanged() {
		let server = app.server!
		if server.phase == .running {
			if !loaded { Task { await connect() } }
			return
		}
		if loaded { return }  // p2's own reconnect state covers a server that went away under an open page
		placeholder.show(for: server)
	}

	// MARK: - Loading

	private func connect() async {
		guard !connecting, !loaded else { return }
		connecting = true
		defer { connecting = false }
		placeholder.show(title: "Signing in…", detail: nil, action: nil)
		do {
			let cookie = try await LocalSignIn.cookie(origin: brain.origin, dataDir: app.server.config.dataDir)
			await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
			loaded = true
			webView.load(URLRequest(url: brain.url(path)))
		} catch {
			// Another data directory, or no key: p2's own sign-in page takes a pasted token instead.
			placeholder.show(title: "Cannot sign in automatically", detail: error.localizedDescription, action: "Sign In with a Token")
			signInWithToken = true
		}
	}

	private var signInWithToken = false

	private func placeholderAction() {
		let server = app.server!
		if signInWithToken {
			signInWithToken = false
			loaded = true
			webView.load(URLRequest(url: brain.url(path)))
		} else if server.canStart {
			Task { await server.start() }
		} else {
			Task { await connect() }
		}
	}

	@objc func reloadPage(_ sender: Any?) {
		if loaded { webView.reload() } else { Task { await connect() } }
	}

	@objc func zoomIn(_ sender: Any?) { setZoom(min(webView.pageZoom + 0.1, 3)) }
	@objc func zoomOut(_ sender: Any?) { setZoom(max(webView.pageZoom - 0.1, 0.5)) }
	@objc func actualSize(_ sender: Any?) { setZoom(1) }

	private func setZoom(_ zoom: CGFloat) {
		webView.pageZoom = zoom
		updateInset()
	}

	// MARK: - Navigation

	func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
		guard let url = action.request.url else { return .cancel }
		if action.shouldPerformDownload { return .download }
		if ["about", "blob", "data"].contains(url.scheme) { return .allow }
		// Frames inside the page (artifact previews) are the page's business; its CSP limits them.
		if let frame = action.targetFrame, !frame.isMainFrame { return .allow }
		guard brain.contains(url) else {
			NSWorkspace.shared.open(url)
			return .cancel
		}
		let modified = action.modifierFlags.contains(.command) || action.buttonNumber == 2
		if action.navigationType == .linkActivated && (modified || action.targetFrame == nil) {
			app.openWindow(brain, path: Self.path(of: url))
			return .cancel
		}
		return .allow
	}

	func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
		let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
		return response.canShowMIMEType && !disposition.lowercased().hasPrefix("attachment") ? .allow : .download
	}

	func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
		download.delegate = self
	}

	func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
		placeholder.isHidden = true
		updateInset()
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		if let url = webView.url, brain.contains(url) { path = Self.path(of: url) }
		Diagnostics.pageFinished(self)
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		if (error as NSError).code == NSURLErrorCancelled { return }
		loaded = false
		placeholder.show(title: "Cannot reach Pi", detail: error.localizedDescription, action: "Try Again")
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		webView.reload()
	}

	// MARK: - Windows, panels, permissions

	func webView(
		_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
		windowFeatures: WKWindowFeatures
	) -> WKWebView? {
		guard let url = action.request.url, url.scheme != "about" else { return nil }
		if brain.contains(url) {
			app.openWindow(brain, path: Self.path(of: url))
		} else {
			NSWorkspace.shared.open(url)
		}
		return nil
	}

	func webView(
		_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo
	) async -> [URL]? {
		let panel = NSOpenPanel()
		panel.allowsMultipleSelection = parameters.allowsMultipleSelection
		panel.canChooseDirectories = parameters.allowsDirectories
		panel.canChooseFiles = true
		guard let window else { return nil }
		return await panel.beginSheetModal(for: window) == .OK ? panel.urls : nil
	}

	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
		_ = await alert(message, buttons: ["OK"])
	}

	func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
		await alert(message, buttons: ["OK", "Cancel"]) == .alertFirstButtonReturn
	}

	func webView(
		_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
		initiatedByFrame frame: WKFrameInfo
	) async -> String? {
		let field = NSTextField(string: defaultText ?? "")
		field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
		return await alert(prompt, buttons: ["OK", "Cancel"], accessory: field) == .alertFirstButtonReturn ? field.stringValue : nil
	}

	// Voice mode: the microphone, for this brain's own pages only. macOS asks the user once for the app.
	func webView(
		_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo,
		type: WKMediaCaptureType
	) async -> WKPermissionDecision {
		origin.protocol == brain.origin.scheme && origin.host == brain.origin.host && origin.port == (brain.origin.port ?? 0)
			? .grant : .deny
	}

	private func alert(_ message: String, buttons: [String], accessory: NSView? = nil) async -> NSApplication.ModalResponse {
		let alert = NSAlert()
		alert.messageText = message
		for title in buttons { alert.addButton(withTitle: title) }
		alert.accessoryView = accessory
		guard let window else { return .cancel }
		return await alert.beginSheetModal(for: window)
	}

	// MARK: - Downloads

	func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
		let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
		let name = (suggestedFilename as NSString).deletingPathExtension
		let ext = (suggestedFilename as NSString).pathExtension
		var candidate = folder.appending(path: suggestedFilename)
		var index = 2
		while FileManager.default.fileExists(atPath: candidate.path) {
			candidate = folder.appending(path: ext.isEmpty ? "\(name) \(index)" : "\(name) \(index).\(ext)")
			index += 1
		}
		return candidate
	}

	func downloadDidFinish(_ download: WKDownload) {
		guard let path = download.progress.fileURL?.path else { return }
		// Bounces the Downloads stack in the Dock, as Safari does.
		DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: path)
	}

	// MARK: - Window

	func windowWillClose(_ notification: Notification) {
		app.windowClosed(self)
	}

	func windowWillEnterFullScreen(_ notification: Notification) { ChromeScript.setInset(0, in: webView) }
	func windowDidExitFullScreen(_ notification: Notification) { updateInset() }

	/// Tells the page how much of its top-left corner the window buttons take.
	private func updateInset() {
		guard let window, !window.styleMask.contains(.fullScreen),
			let zoom = window.standardWindowButton(.zoomButton), let frame = zoom.superview?.convert(zoom.frame, to: nil)
		else { return ChromeScript.setInset(0, in: webView) }
		ChromeScript.setInset((frame.maxX + 12) / (webView.pageZoom * webView.magnification), in: webView)
	}

	private static func path(of url: URL) -> String {
		var path = url.path(percentEncoded: true)
		if path.isEmpty { path = "/" }
		if let query = url.query(percentEncoded: true) { path += "?\(query)" }
		if let fragment = url.fragment(percentEncoded: true) { path += "#\(fragment)" }
		return path
	}
}

/// The native view over the webview while there is no page: the server's state and one action.
@MainActor
private final class Placeholder: NSView {
	var onAction: (() -> Void)?
	private let title = NSTextField(labelWithString: "")
	private let detail = NSTextField(wrappingLabelWithString: "")
	private let button = NSButton(title: "", target: nil, action: nil)

	init() {
		super.init(frame: .zero)
		wantsLayer = true
		layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
		title.font = .systemFont(ofSize: 20, weight: .semibold)
		detail.textColor = .secondaryLabelColor
		detail.alignment = .center
		detail.preferredMaxLayoutWidth = 420
		button.bezelStyle = .push
		button.controlSize = .large
		button.keyEquivalent = "\r"
		button.target = self
		button.action = #selector(act)
		let stack = NSStackView(views: [title, detail, button])
		stack.orientation = .vertical
		stack.spacing = 12
		stack.translatesAutoresizingMaskIntoConstraints = false
		addSubview(stack)
		NSLayoutConstraint.activate([
			stack.centerXAnchor.constraint(equalTo: centerXAnchor),
			stack.centerYAnchor.constraint(equalTo: centerYAnchor),
		])
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) { fatalError("not used") }

	func show(for server: ServerController) {
		switch server.phase {
		case .checking: show(title: "Looking for Pi…", detail: nil, action: nil)
		case .starting: show(title: "Starting Pi…", detail: server.config.origin.absoluteString, action: nil)
		case .stopping: show(title: "Stopping Pi…", detail: nil, action: nil)
		case .running: show(title: "Signing in…", detail: nil, action: nil)
		case .stopped where server.config.source == .attached:
			show(
				title: "Pi is not running",
				detail: "Waiting for the server at \(server.config.origin.host!):\(server.config.port). Start it in its checkout, or choose another server in the menu bar.",
				action: nil)
		case .stopped:
			server.config.checkout == nil
				? show(title: "Pi is not running", detail: "Choose a p2 checkout in the menu bar item to run it from this app.", action: nil)
				: show(title: "Pi is stopped", detail: nil, action: "Start Pi")
		case .failed(let message): show(title: "Pi is not running", detail: message, action: server.canStart ? "Start Pi" : nil)
		}
	}

	func show(title: String, detail: String?, action: String?) {
		isHidden = false
		self.title.stringValue = title
		self.detail.stringValue = detail ?? ""
		self.detail.isHidden = detail == nil
		button.title = action ?? ""
		button.isHidden = action == nil
	}

	@objc private func act() { onAction?() }
}
