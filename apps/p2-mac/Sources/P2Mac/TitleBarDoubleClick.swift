// A double click on the parts of the window that stand in for its title bar: the brain tab bar (BrainTabBar.swift)
// and, without it, the page's top strip (WindowChrome.swift). Both cover the transparent title bar, so AppKit hands
// their clicks to them and the title bar never sees the double click; they pass it on here.
import AppKit

extension NSWindow {
	/// Does what a double click on a native title bar does, as the system setting says: zoom, fill, minimize or nothing.
	func titleBarDoubleClicked(_ event: NSEvent) {
		// The window's frame view runs the title bar's own handling, so every setting (Fill included, which has no
		// public API) behaves as in other windows. It is private: on a macOS without it, the public actions stand in.
		if let frame = contentView?.superview, frame.responds(to: Self.titleBarHandler) {
			frame.perform(Self.titleBarHandler, with: event)
			return
		}
		switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
		case "Minimize": performMiniaturize(nil)
		case "None": break
		default: performZoom(nil)
		}
	}

	private static let titleBarHandler = NSSelectorFromString("_handlePossibleDoubleClickForEvent:")
}
