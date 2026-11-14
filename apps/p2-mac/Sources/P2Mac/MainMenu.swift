// The main menu while a window is open. The Edit menu matters: without it Cmd-C/V/X/A/Z do nothing in the webview.
// WebKit offers key equivalents to the page first, so the page keeps the keys it handles.
import AppKit

@MainActor
enum MainMenu {
	/// The app's main menu: Pi, File, Edit, View (with Appearance: the app's light/dark preference), Window.
	static func build() -> NSMenu {
		let main = NSMenu()
		main.addItem(submenu("Pi", [
			item("About Pi", "orderFrontStandardAboutPanel:"),
			.separator(),
			item("Hide Pi", "hide:", "h"),
			item("Hide Others", "hideOtherApplications:", "h", [.command, .option]),
			item("Show All", "unhideAllApplications:"),
			.separator(),
			item("Quit Pi", "terminate:", "q"),
		]))
		main.addItem(submenu("File", [
			item("New Window", "newWindow:", "n", [.command, .shift]),
			.separator(),
			item("Close Window", "performClose:", "w"),
		]))
		main.addItem(submenu("Edit", [
			item("Undo", "undo:", "z"),
			item("Redo", "redo:", "z", [.command, .shift]),
			.separator(),
			item("Cut", "cut:", "x"),
			item("Copy", "copy:", "c"),
			item("Paste", "paste:", "v"),
			item("Paste and Match Style", "pasteAsPlainText:", "v", [.command, .option, .shift]),
			item("Select All", "selectAll:", "a"),
		]))
		main.addItem(submenu("View", [
			item("Reload Page", "reloadPage:", "r"),
			.separator(),
			item("Actual Size", "actualSize:", "0"),
			item("Zoom In", "zoomIn:", "+"),
			item("Zoom Out", "zoomOut:", "-"),
			.separator(),
			submenu("Appearance", Appearance.allCases.map { preference in
				let entry = item(preference.title, "chooseAppearance:")
				entry.representedObject = preference.rawValue
				return entry
			}),
			.separator(),
			item("Enter Full Screen", "toggleFullScreen:", "f", [.command, .control]),
		]))
		let window = submenu("Window", [
			item("Minimize", "performMiniaturize:", "m"),
			item("Zoom", "performZoom:"),
			.separator(),
			item("Bring All to Front", "arrangeInFront:"),
		])
		main.addItem(window)
		NSApp.windowsMenu = window.submenu
		return main
	}

	/// The Window menu's brains, in tab order: ⌘1–9 select the first nine in the key window.
	static func updateBrains(_ brains: [Brain]) {
		guard let menu = NSApp.windowsMenu else { return }
		for item in menu.items where item.action == NSSelectorFromString("selectBrain:") || item.tag == brainSeparatorTag {
			menu.removeItem(item)
		}
		guard brains.count > 1 else { return }
		let separator = NSMenuItem.separator()
		separator.tag = brainSeparatorTag
		menu.insertItem(separator, at: 0)
		for (index, brain) in brains.prefix(9).enumerated().reversed() {
			let entry = item(brain.label, "selectBrain:", String(index + 1))
			entry.tag = index
			menu.insertItem(entry, at: 0)
		}
	}

	private static let brainSeparatorTag = 9_999

	private static func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
		let menu = NSMenu(title: title)
		for item in items { menu.addItem(item) }
		let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
		holder.submenu = menu
		return holder
	}

	// Actions go to the first responder: the webview, its window, the window's controller, then the app delegate.
	private static func item(_ title: String, _ action: String, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command) -> NSMenuItem {
		let item = NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key)
		item.keyEquivalentModifierMask = modifiers
		return item
	}
}
