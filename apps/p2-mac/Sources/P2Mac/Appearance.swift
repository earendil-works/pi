// The app's light/dark preference. In a Pi window the app is the outermost host, so it owns the preference for every
// brain page (direct and remote): p2's own switch asks the app through the page bridge (HostBridge.swift) instead of
// storing a value of its own. Setting `NSApp.appearance` is all the native side needs: the tab bar, the placeholder
// and WKWebView's `prefers-color-scheme` follow the effective appearance, so a page in "system" mode needs no message.
//
// A change the app makes (View > Appearance, the bridge) cross-fades. Each document and the app fade their own pixels:
// the page runs its own view transition when its scheme changes (apps/p2/src/web/theme.ts), so the app fades only the
// views it draws itself (`crossFade`), never the content view or the webview's layer, which would stack a second fade
// over the page's. No fade at launch, with Reduce Motion, or for the system's own switch (macOS fades the screen).
import AppKit
import QuartzCore

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

	/// The fade of an app-driven change: about as long as the page's view transition (the browser's default 250 ms).
	private static let fadeDuration: CFTimeInterval = 0.25

	/// Cross-fades what `view` and its subviews draw into their next state, the redraw for a new appearance; added
	/// before the change, in the same run loop turn. Nothing with Reduce Motion, and nothing for a hidden view.
	@MainActor
	static func crossFade(_ view: NSView) {
		guard !view.isHidden, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
		view.wantsLayer = true
		let fade = CATransition()
		fade.type = .fade
		fade.duration = fadeDuration
		fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
		view.layer?.add(fade, forKey: "pi-appearance")
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
