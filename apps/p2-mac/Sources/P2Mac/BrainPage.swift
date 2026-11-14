// One brain's page in a window: a WKWebView with native link, download, file panel, dialog and permission handling.
// This Mac's brain loads directly and signs in with the owner key, behind a native placeholder while its server is not
// reachable. Other Pis load from Radius's forwarded origin for them (`https://<label>.rdtun.com`), as the page itself,
// through a grant the app gets with the shared Radius credential; when the origin's view cookie has expired it sends
// the page to Radius's `/pi/forward`, and the app gets a fresh grant instead. A window keeps the pages of its recent
// brains (PiWindowController), so switching tabs is instant. Every page gets the host bridge (HostBridge.swift).
import AppKit
import WebKit

@MainActor
final class BrainPage: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
	let brain: Brain
	let webView: ChromeWebView
	/// The webview and the placeholder over it.
	let view = NSView()
	private unowned let host: PiWindowController
	private let placeholder = Placeholder()
	private(set) var path: String
	private var loaded = false
	private var connecting = false
	private var signInWithToken = false
	/// A remote Pi's forwarded origin, learned from its first grant URL.
	private var remoteOrigin: URL?
	private var urlObservation: NSKeyValueObservation?

	/// The page is directly under the window buttons (no tab bar): it gets their inset and drags the window.
	var bare = false {
		didSet {
			webView.dragsWindow = bare
			updateInset()
		}
	}

	private var window: NSWindow? { host.window }
	var app: AppDelegate { host.app }

	init(brain: Brain, path: String, host: PiWindowController) {
		self.brain = brain
		self.path = path
		self.host = host
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
		super.init()
		if brain.isDirect {
			ChromeScript.install(in: configuration.userContentController) { [weak webView] rects in
				webView?.interactive = rects
			}
		}
		HostBridge.install(in: configuration.userContentController, for: self)
		for subview in [webView, placeholder] as [NSView] {
			subview.translatesAutoresizingMaskIntoConstraints = false
			view.addSubview(subview)
			NSLayoutConstraint.activate([
				subview.leadingAnchor.constraint(equalTo: view.leadingAnchor),
				subview.trailingAnchor.constraint(equalTo: view.trailingAnchor),
				subview.topAnchor.constraint(equalTo: view.topAnchor),
				subview.bottomAnchor.constraint(equalTo: view.bottomAnchor),
			])
		}
		webView.navigationDelegate = self
		webView.uiDelegate = self
		// The address follows the page, including p2's own history changes (it replaces its URL without loading), so a
		// window can reopen where it was.
		urlObservation = webView.observe(\.url) { [weak self] webView, _ in
			MainActor.assumeIsolated {
				guard let self, let url = webView.url, self.owns(url) else { return }
				self.path = Self.path(of: url)
			}
		}
		placeholder.onAction = { [weak self] in self?.placeholderAction() }
		if case .remote = brain.route {
			loaded = true
			Task { await openRemote() }
		}
	}

	/// Whether `url` is this Pi's own page: its loopback origin, or its forwarded origin.
	private func owns(_ url: URL) -> Bool {
		if brain.isDirect { return brain.route.contains(url) }
		guard let remoteOrigin else { return false }
		return url.scheme == remoteOrigin.scheme && url.host == remoteOrigin.host
	}

	/// Whether a frame on `origin` is this Pi's own: only those get the microphone and the host bridge.
	func owns(_ origin: WKSecurityOrigin) -> Bool {
		let page: URL? = brain.isDirect ? brain.route.url("/") : remoteOrigin
		guard let page else { return false }
		return origin.protocol == page.scheme && origin.host == page.host && origin.port == (page.port ?? 0)
	}

	/// Cross-fades the placeholder into the next appearance; the page fades itself.
	func crossFadeNativeViews() {
		Appearance.crossFade(placeholder)
	}

	/// Tells the page the app's light/dark preference changed, if a page of this Pi is loaded.
	func appearanceChanged(_ preference: Appearance) {
		guard let url = webView.url, owns(url) else { return }
		HostBridge.themeChanged(preference, in: webView)
	}

	/// Opens `path` on a remote Pi through a fresh grant.
	private func openRemote() async {
		guard case .remote(let organization, let server) = brain.route else { return }
		placeholder.show(title: "Opening \(brain.name)…", detail: nil, action: nil)
		do {
			let url = try await host.app.radius.openURL(organization: organization, server: server, path: path)
			remoteOrigin = URL(string: "\(url.scheme!)://\(url.host!)\(url.port.map { ":\($0)" } ?? "")")
			webView.load(URLRequest(url: url))
		} catch {
			placeholder.show(title: "Cannot open \(brain.name)", detail: error.localizedDescription, action: "Try Again")
		}
	}

	/// Follows this Mac's server: connects once it runs, shows why not otherwise.
	func serverChanged(_ server: ServerController) {
		guard brain.isDirect else { return }
		if server.phase == .running {
			if !loaded { Task { await connect() } }
			return
		}
		if loaded { return }  // p2's own reconnect state covers a server that went away under an open page
		placeholder.show(for: server)
	}

	// MARK: - Loading

	private func connect() async {
		guard !connecting, !loaded, case .direct(let origin, let dataDir) = brain.route else { return }
		connecting = true
		defer { connecting = false }
		placeholder.show(title: "Signing in…", detail: nil, action: nil)
		do {
			let cookie = try await LocalSignIn.cookie(origin: origin, dataDir: dataDir)
			await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
			loaded = true
			webView.load(URLRequest(url: brain.route.url(path)))
		} catch {
			// Another data directory, or no key: p2's own sign-in page takes a pasted token instead.
			placeholder.show(title: "Cannot sign in automatically", detail: error.localizedDescription, action: "Sign In with a Token")
			signInWithToken = true
		}
	}

	private func placeholderAction() {
		let server = host.app.server!
		if case .remote = brain.route {
			Task { await openRemote() }
		} else if signInWithToken {
			signInWithToken = false
			loaded = true
			webView.load(URLRequest(url: brain.route.url(path)))
		} else if server.canStart {
			Task { await server.start() }
		} else {
			Task { await connect() }
		}
	}

	func reload() {
		if case .remote = brain.route, webView.url == nil {
			Task { await openRemote() }
			return
		}
		if loaded { webView.reload() } else { Task { await connect() } }
	}

	func setZoom(_ zoom: CGFloat) {
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
		// The forwarded origin's view cookie expired: it asks Radius for a new grant, the app gets one itself.
		if case .remote = brain.route, url.path == "/pi/forward" {
			if let wanted = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value,
				wanted.hasPrefix("/")
			{
				path = wanted
			}
			Task { await openRemote() }
			return .cancel
		}
		guard owns(url) else {
			NSWorkspace.shared.open(url)
			return .cancel
		}
		let modified = action.modifierFlags.contains(.command) || action.buttonNumber == 2
		if action.navigationType == .linkActivated && (modified || action.targetFrame == nil) {
			host.app.openWindow(brain.id, path: Self.path(of: url))
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
		// A brain's own page opens in a window on that brain; everything else (a Radius link too) in the browser.
		if owns(url) {
			host.app.openWindow(brain.id, path: Self.path(of: url))
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
		owns(origin) ? .grant : .deny
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

	/// Tells the page how much of its top-left corner the window buttons take: none under a tab bar or in full screen.
	func updateInset() {
		guard brain.isDirect else { return }
		guard bare, let window, !window.styleMask.contains(.fullScreen),
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

	// Drawn, not a layer colour resolved once: AppKit redraws the view when the app's appearance changes.
	override func draw(_ dirtyRect: NSRect) {
		NSColor.windowBackgroundColor.setFill()
		dirtyRect.fill()
	}

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
