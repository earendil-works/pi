// A Pi window: the brain tab bar (while signed in to Radius) and, under it, the page of the selected brain. The bar
// belongs to the window and never reloads; switching tabs swaps the page below. The window keeps the pages of its
// most recent brains, so switching back is instant and keeps their state. Without Radius there is no bar and the page
// fills the window under the window buttons (WindowChrome.swift).
import AppKit

@MainActor
final class PiWindowController: NSWindowController, NSWindowDelegate {
	unowned let app: AppDelegate
	private(set) var selected: String
	private let tabBar = BrainTabBar()
	private let content = NSView()
	private var pages: [String: BrainPage] = [:]
	/// Brain IDs by recency, the selected one last.
	private var recent: [String] = []
	private var contentTop: NSLayoutConstraint!
	private var observer: NSObjectProtocol?

	/// Pages kept alive per window besides the selected one.
	private static let keptPages = 3

	init(app: AppDelegate, brain: String, path: String) {
		self.app = app
		selected = brain
		let window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
			styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
			backing: .buffered,
			defer: false
		)
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		// An empty unified toolbar: the window buttons of a window with a toolbar, centred 26 points from the top.
		let toolbar = NSToolbar(identifier: "pi-window")
		toolbar.showsBaselineSeparator = false
		window.toolbar = toolbar
		window.toolbarStyle = .unified
		// Brain tabs replace macOS's window tabs: two levels of tabs would confuse.
		window.tabbingMode = .disallowed
		window.minSize = NSSize(width: 420, height: 360)
		window.isReleasedWhenClosed = false
		super.init(window: window)
		window.delegate = self

		let root = NSView()
		for view in [content, tabBar] as [NSView] {
			view.translatesAutoresizingMaskIntoConstraints = false
			root.addSubview(view)
		}
		contentTop = content.topAnchor.constraint(equalTo: root.topAnchor)
		NSLayoutConstraint.activate([
			tabBar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
			tabBar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
			tabBar.topAnchor.constraint(equalTo: root.topAnchor),
			tabBar.heightAnchor.constraint(equalToConstant: BrainTabBar.height),
			content.leadingAnchor.constraint(equalTo: root.leadingAnchor),
			content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
			content.bottomAnchor.constraint(equalTo: root.bottomAnchor),
			contentTop,
		])
		window.contentView = root
		tabBar.onSelect = { [weak self] id, modifiers in
			guard let self else { return }
			if modifiers.contains(.command) { self.app.openWindow(id, path: "/") } else { self.select(id) }
		}
		tabBar.onDetach = { [weak self] id in self?.app.openWindow(id, path: "/") }
		observer = NotificationCenter.default.addObserver(forName: BrainDirectory.changed, object: nil, queue: .main) { [weak self] _ in
			MainActor.assumeIsolated { self?.directoryChanged() }
		}
		show(brain, path: path)
		directoryChanged()
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) { fatalError("not used") }

	/// Shows `id`'s page, creating it at `path` if the window has none for it.
	func select(_ id: String, path: String = "/") {
		guard id != selected || pages[id] == nil else { return }
		show(id, path: path)
		directoryChanged()
	}

	/// The selected page.
	var page: BrainPage? { pages[selected] }

	/// Follows this Mac's server into the pages on it.
	func serverChanged() {
		for page in pages.values { page.serverChanged(app.server) }
	}

	/// Cross-fades the views the window draws itself (the tab bar, the pages' placeholders) into the next appearance.
	func crossFadeNativeViews() {
		Appearance.crossFade(tabBar)
		for page in pages.values { page.crossFadeNativeViews() }
	}

	/// Tells every page of the window that the light/dark preference changed.
	func appearanceChanged(_ preference: Appearance) {
		for page in pages.values { page.appearanceChanged(preference) }
	}

	private func show(_ id: String, path: String) {
		selected = id
		recent.removeAll { $0 == id }
		recent.append(id)
		guard let brain = app.directory.brain(id) else { return }
		let page: BrainPage
		if let existing = pages[id], existing.brain.route == brain.route {
			page = existing
		} else {
			pages[id]?.view.removeFromSuperview()
			page = BrainPage(brain: brain, path: path, host: self)
			pages[id] = page
			page.view.translatesAutoresizingMaskIntoConstraints = false
			content.addSubview(page.view)
			NSLayoutConstraint.activate([
				page.view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
				page.view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
				page.view.topAnchor.constraint(equalTo: content.topAnchor),
				page.view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
			])
			page.serverChanged(app.server)
		}
		for (other, view) in pages.map({ ($0.key, $0.value.view) }) { view.isHidden = other != id }
		window?.title = brain.name
		window?.makeFirstResponder(page.webView)
		// The least recently shown pages go; their brains reload when selected again.
		while recent.count > Self.keptPages + 1 {
			let dropped = recent.removeFirst()
			pages.removeValue(forKey: dropped)?.view.removeFromSuperview()
		}
	}

	/// The brain list or the sign-in state changed: the bar, and a page whose brain went away.
	private func directoryChanged() {
		let directory: BrainDirectory = app.directory
		let showsBar = directory.showsTabs
		tabBar.isHidden = !showsBar
		contentTop.constant = showsBar ? BrainTabBar.height : 0
		tabBar.leadingInset = buttonsInset()
		tabBar.update(brains: directory.brains, selected: selected)
		for page in pages.values { page.bare = !showsBar }
		// Pages of brains that left the list (signed out, unshared) go; the selected one is replaced below.
		for (id, page) in pages where id != selected && directory.brain(id) == nil {
			page.view.removeFromSuperview()
			pages.removeValue(forKey: id)
			recent.removeAll { $0 == id }
		}
		if directory.brain(selected) == nil, let fallback = directory.local ?? directory.brains.first {
			show(fallback.id, path: "/")
			tabBar.update(brains: directory.brains, selected: selected)
		}
		if let brain = directory.brain(selected) { window?.title = brain.name }
	}

	/// Where the tabs start: right of the window buttons, or the bar's padding in full screen.
	private func buttonsInset() -> CGFloat {
		guard let window, !window.styleMask.contains(.fullScreen),
			let zoom = window.standardWindowButton(.zoomButton), let frame = zoom.superview?.convert(zoom.frame, to: nil)
		else { return 16 }
		return frame.maxX + 20
	}

	// MARK: - Menu actions (first responder chain: the window's delegate)

	@objc func reloadPage(_ sender: Any?) { page?.reload() }
	@objc func zoomIn(_ sender: Any?) { page.map { $0.setZoom(min($0.webView.pageZoom + 0.1, 3)) } }
	@objc func zoomOut(_ sender: Any?) { page.map { $0.setZoom(max($0.webView.pageZoom - 0.1, 0.5)) } }
	@objc func actualSize(_ sender: Any?) { page?.setZoom(1) }

	/// ⌘1–9 in the Window menu: the brain at that tab position.
	@objc func selectBrain(_ sender: NSMenuItem) {
		let brains = app.directory.brains
		guard brains.indices.contains(sender.tag) else { return }
		select(brains[sender.tag].id)
	}

	// MARK: - Window

	func windowWillClose(_ notification: Notification) {
		if let observer { NotificationCenter.default.removeObserver(observer) }
		app.windowClosed(self)
	}

	func windowDidEnterFullScreen(_ notification: Notification) { chromeChanged() }
	func windowDidExitFullScreen(_ notification: Notification) { chromeChanged() }

	private func chromeChanged() {
		tabBar.leadingInset = buttonsInset()
		for page in pages.values { page.updateInset() }
	}
}
