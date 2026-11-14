// The app's light/dark preference. In a Pi window the app is the outermost host, so it owns the preference for every
// brain page (direct and remote): p2's own switch asks the app through the page bridge (HostBridge.swift) instead of
// storing a value of its own. Setting `NSApp.appearance` is all the native side needs: the tab bar, the placeholder
// and WKWebView's `prefers-color-scheme` follow the effective appearance, so a page in "system" mode needs no message.
import AppKit

enum Appearance: String, CaseIterable {
	case system
	case light
	case dark

	/// The title in View > Appearance.
	var title: String {
		switch self {
		case .system: "System"
		case .light: "Light"
		case .dark: "Dark"
		}
	}

	private static let key = "appearance"

	/// The launch's preference: the user default `appearance`, else the system's.
	static func load() -> Appearance {
		UserDefaults.standard.string(forKey: key).flatMap(Appearance.init) ?? .system
	}

	/// Makes this the app's appearance; nil follows the system.
	@MainActor
	func apply() {
		switch self {
		case .system: NSApp.appearance = nil
		case .light: NSApp.appearance = NSAppearance(named: .aqua)
		case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
		}
	}

	/// Remembers this preference as the user default `appearance` (absent: system).
	func save() {
		if self == .system {
			UserDefaults.standard.removeObject(forKey: Self.key)
		} else {
			UserDefaults.standard.set(rawValue, forKey: Self.key)
		}
	}
}
