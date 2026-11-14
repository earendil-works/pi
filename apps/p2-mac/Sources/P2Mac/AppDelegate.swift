// The app: the menu bar item that manages the local server, the main menu, and the brain windows. It is a menu bar
// app (LSUIElement) that becomes a regular app with a Dock icon while a window is open.
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSMenuItemValidation {
	/// The light/dark preference every window and page follows.
	private(set) var appearance = Appearance.load()
	private(set) var server: ServerController!
	private(set) var directory: BrainDirectory!
	private(set) var radius: RadiusAccount!
	private var statusItem: NSStatusItem!
	private var windows: [PiWindowController] = []
	private var found: [FoundServer] = []
	private let serverMenu = NSMenu()
	// One item for the submenu, re-added on every rebuild: a submenu belongs to one item for good.
	private lazy var serverItem: NSMenuItem = {
		let item = NSMenuItem(title: "Server", action: nil, keyEquivalent: "")
		item.submenu = serverMenu
		return item
	}()
	private var quitting = false
	private var signals: [DispatchSourceSignal] = []

	func applicationDidFinishLaunching(_ notification: Notification) {
		// Before the first window, so nothing paints in the other appearance first.
		appearance.apply()
		NSApp.mainMenu = MainMenu.build()
		NotificationCenter.default.addObserver(forName: BrainDirectory.changed, object: nil, queue: .main) { notification in
			MainActor.assumeIsolated {
				if let directory = notification.object as? BrainDirectory { MainMenu.updateBrains(directory.brains) }
			}
		}
		// Ctrl-C in a terminal or a plain kill quits like the Quit command, so the app's own server stops too.
		for number in [SIGINT, SIGTERM] {
			signal(number, SIG_IGN)
			let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
			// Through the run loop, not this main-queue block: terminating waits in a nested run loop for the server to
			// stop, and the main queue cannot run the work that ends that wait while one of its blocks is still running.
			source.setEventHandler { NSApp.perform(#selector(NSApplication.terminate(_:)), with: nil, afterDelay: 0) }
			source.resume()
			signals.append(source)
		}
		statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
		statusItem.button?.image = PiGlyph.templateImage(size: 15)
		statusItem.button?.appearsDisabled = true
		let menu = NSMenu()
		menu.delegate = self
		statusItem.menu = menu
		use(.load())
		Task { found = await ServerScan.scan() }
	}

	func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
		if !hasVisibleWindows { openPi(nil) }
		return true
	}

	func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

	// The spike's server is a child of the app: stop it with the app. (The LaunchAgent will outlive the app.)
	func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
		guard server.ownership == .managed, !quitting else { return .terminateNow }
		quitting = true
		server.stop()
		Task {
			await server.waitForExit(seconds: 16)
			NSApp.reply(toApplicationShouldTerminate: true)
		}
		return .terminateLater
	}

	// MARK: - Servers

	/// Switches to the server `config` describes: stops the app's own server if it ran one, and reopens the window.
	private func use(_ config: ServerConfig) {
		let previous = server
		Task {
			if let previous {
				previous.invalidate()
				if previous.ownership == .managed {
					previous.stop()
					await previous.waitForExit(seconds: 16)
				}
			}
			for window in windows { window.close() }
			watch(ServerController(config: config))
			openPi(nil)
			await server.poll()
			if server.phase == .stopped && server.canStart { await server.start() }
		}
	}

	private func watch(_ controller: ServerController) {
		server = controller
		controller.onChange = { [weak self] in self?.serverChanged() }
		if let radius {
			radius.server = controller
		} else {
			radius = RadiusAccount(server: controller)
			if radius.headless { signInToRadius() }
		}
		if let directory { directory.server = controller } else { directory = BrainDirectory(server: controller, radius: radius) }
		MainMenu.updateBrains(directory.brains)
	}

	@objc private func useFound(_ sender: NSMenuItem) {
		guard let found = sender.representedObject as? FoundServerBox else { return }
		ServerConfig.saveAttached(port: found.server.port, dataDir: found.server.dataDir)
		use(ServerConfig.own().attached(port: found.server.port, dataDir: found.server.dataDir))
	}

	@objc private func useOwn(_ sender: NSMenuItem) {
		ServerConfig.saveOwn()
		use(.own())
	}

	// MARK: - Windows

	/// Opens `path` of brain `id` in a new window.
	func openWindow(_ id: String, path: String) {
		let controller = PiWindowController(app: self, brain: id, path: path)
		let previous = windows.last?.window
		windows.append(controller)
		if let window = controller.window {
			if let previous {
				window.setFrame(previous.frame, display: false)
				window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: previous.frame.minX, y: previous.frame.maxY)))
			} else {
				window.setFrameAutosaveName("Pi.main")
				if !window.setFrameUsingName("Pi.main") { window.center() }
			}
		}
		NSApp.setActivationPolicy(.regular)
		controller.showWindow(nil)
		NSApp.activate()
	}

	func windowClosed(_ controller: PiWindowController) {
		windows.removeAll { $0 === controller }
		if windows.isEmpty { NSApp.setActivationPolicy(.accessory) }
	}

	/// Brings up a window: the frontmost one, else a new one on this Mac's brain.
	@objc func openPi(_ sender: Any?) {
		if let existing = windows.last {
			existing.showWindow(nil)
			NSApp.activate()
		} else if let brain = directory.local ?? directory.brains.first {
			openWindow(brain.id, path: "/")
		}
	}

	@objc func newWindow(_ sender: Any?) {
		let current = (NSApp.keyWindow?.delegate as? PiWindowController)?.selected
		if let id = current ?? directory.local?.id { openWindow(id, path: "/") }
	}

	// MARK: - Appearance

	/// Makes `preference` the app's light/dark preference: stores it, applies it (cross-fading the native views), and
	/// tells every page.
	func setAppearance(_ preference: Appearance) {
		appearance = preference
		for window in windows { window.crossFadeNativeViews() }
		preference.apply()
		preference.save()
		for window in windows { window.appearanceChanged(preference) }
	}

	/// View > Appearance: the item's preference.
	@objc func chooseAppearance(_ sender: NSMenuItem) {
		if let preference = (sender.representedObject as? String).flatMap(Appearance.init) { setAppearance(preference) }
	}

	func validateMenuItem(_ item: NSMenuItem) -> Bool {
		if item.action == #selector(chooseAppearance) {
			item.state = item.representedObject as? String == appearance.rawValue ? .on : .off
		}
		return true
	}

	private func serverChanged() {
		statusItem.button?.appearsDisabled = server.phase != .running
		directory.rebuild()
		for window in windows { window.serverChanged() }
	}

	// MARK: - Menu bar item

	// The scan takes up to a second. Rebuilding the open menu afterwards would resize it under the pointer, so only the
	// Server submenu takes its result; it shows the previous scan until then.
	func menuWillOpen(_ menu: NSMenu) {
		Task {
			found = await ServerScan.scan()
			fillServerMenu()
		}
	}

	func menuNeedsUpdate(_ menu: NSMenu) {
		menu.removeAllItems()
		let config = server.config
		menu.addItem(disabled(statusLine()))
		menu.addItem(disabled(detailLine()))
		menu.addItem(.separator())
		menu.addItem(item("Open Pi", #selector(openPi), key: "o"))
		menu.addItem(.separator())
		if server.canStart { menu.addItem(item("Start Pi", #selector(startServer))) }
		if server.canRestart { menu.addItem(item("Restart Pi", #selector(restartServer))) }
		if server.canStop { menu.addItem(item("Stop Pi", #selector(stopServer))) }
		if config.source == .own, FileManager.default.fileExists(atPath: server.logFile.path) {
			menu.addItem(item("Show Server Log", #selector(showLog)))
		}
		menu.addItem(.separator())
		if directory.fixture {
			menu.addItem(disabled("Radius: brains from P2MAC_BRAINS"))
		} else if radius.signedIn {
			menu.addItem(disabled("Signed in to Radius · with this Mac's Pi"))
			menu.addItem(item("Sign Out of Radius", #selector(signOutOfRadius)))
		} else {
			menu.addItem(item("Sign In to Radius…", #selector(signInToRadius)))
		}
		fillServerMenu()
		menu.addItem(serverItem)
		menu.addItem(.separator())
		menu.addItem(item("Quit Pi", #selector(NSApplication.terminate(_:)), key: "q", target: NSApp))
	}

	/// The servers to choose from: the running ones found on this Mac, and the app's own.
	private func fillServerMenu() {
		let menu = serverMenu
		menu.removeAllItems()
		let config = server.config
		menu.addItem(disabled(found.isEmpty ? "No running Pi servers found" : "Running on this Mac"))
		for found in found {
			var title = "127.0.0.1:\(found.port) · \(abbreviate(found.dataDir.path))"
			if let checkout = found.checkout { title += " · \(abbreviate(checkout.path))" }
			if found.dev { title += " · dev" }
			let entry = item(title, #selector(useFound))
			entry.representedObject = FoundServerBox(found)
			entry.state = config.source == .attached && config.port == found.port ? .on : .off
			menu.addItem(entry)
		}
		menu.addItem(.separator())
		let ownTitle = config.checkout.map { "Run Pi from \(abbreviate($0.path))" } ?? "Run Pi from a Checkout"
		let own = item(ownTitle, #selector(useOwn))
		own.state = config.source == .own ? .on : .off
		own.isEnabled = config.checkout != nil
		menu.addItem(own)
		menu.addItem(item("Choose p2 Checkout…", #selector(chooseCheckout)))
	}

	private func statusLine() -> String {
		switch server.phase {
		case .checking: "Looking for Pi…"
		case .starting: "Pi is starting…"
		case .running: "Pi is running · On this Mac"
		case .stopping: "Pi is stopping…"
		case .stopped: server.config.source == .attached ? "Pi is not running" : "Pi is stopped"
		case .failed(let message): "Pi is not running: \(message)"
		}
	}

	private func detailLine() -> String {
		let config = server.config
		var detail = "127.0.0.1:\(config.port) · \(abbreviate(config.dataDir.path))"
		if server.ownership == .external || config.source == .attached {
			detail += DevControl.available(dataDir: config.dataDir) ? " · run elsewhere (dev)" : " · run elsewhere"
		}
		return detail
	}

	@objc func signInToRadius() {
		Task {
			do {
				try await radius.signIn()
			} catch is CancellationError {
			} catch {
				NSApp.activate()
				let alert = NSAlert()
				alert.messageText = "Could not sign in to Radius"
				alert.informativeText = error.localizedDescription
				alert.runModal()
			}
			NSApp.activate()
		}
	}

	/// Removes the shared credential: this Mac's Pi disconnects too.
	@objc private func signOutOfRadius() {
		radius.signOut()
	}

	@objc private func startServer() { Task { await server.start() } }
	@objc private func stopServer() { server.stop() }
	@objc private func restartServer() { Task { await server.restart() } }

	@objc private func showLog() {
		NSWorkspace.shared.open(
			[server.logFile], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"),
			configuration: NSWorkspace.OpenConfiguration())
	}

	@objc private func chooseCheckout() {
		let panel = NSOpenPanel()
		panel.canChooseDirectories = true
		panel.canChooseFiles = false
		panel.message = "Choose a pi-mono checkout or its apps/p2 directory"
		NSApp.activate()
		guard panel.runModal() == .OK, let folder = panel.url else { return }
		guard let p2 = ServerConfig.p2Directory(folder) else {
			let alert = NSAlert()
			alert.messageText = "No p2 in \(folder.path)"
			alert.informativeText = "Choose a folder that contains apps/p2/src/hosts/server.ts."
			alert.runModal()
			return
		}
		ServerConfig.saveCheckout(p2)
		ServerConfig.saveOwn()
		use(.own())
	}

	private func item(_ title: String, _ action: Selector, key: String = "", target: AnyObject? = nil) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
		item.target = target ?? self
		return item
	}

	private func disabled(_ title: String) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		item.isEnabled = false
		return item
	}

	private func abbreviate(_ path: String) -> String { (path as NSString).abbreviatingWithTildeInPath }
}

/// A found server as a menu item's represented object.
private final class FoundServerBox: NSObject {
	let server: FoundServer
	init(_ server: FoundServer) { self.server = server }
}
