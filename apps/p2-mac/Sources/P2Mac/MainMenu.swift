// The main menu while a window is open. The Edit menu matters: without it Cmd-C/V/X/A/Z do nothing in the webview.
// WebKit offers key equivalents to the page first, so the page keeps the keys it handles.
import AppKit

@MainActor
enum MainMenu {
	/// The app's main menu: Pi, File, Edit, View, Window.
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
