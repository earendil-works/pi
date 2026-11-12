// The window's brain tabs, shown while signed in to Radius: the Radius shell's tab bar (pi-shell/PiShell.tsx, Elanor's
// Tabs) drawn natively in the window's title bar row, next to the window buttons. It belongs to the window, not to a
// page, so it stays put while the page under it changes. A click selects a tab in place, Cmd-click or the middle
// button opens it in a window of its own, and so does dragging a tab out of the bar. The bar's empty parts drag the
// window, and a double click there does what the title bar's would.
import AppKit

@MainActor
final class BrainTabBar: NSView {
	/// p2's `--bar`: the window buttons centre on it, as on p2's own bars.
	static let height: CGFloat = 52

	/// A tab was clicked (modifiers say where to open it) or dragged out of the bar.
	var onSelect: ((String, NSEvent.ModifierFlags) -> Void)?
	var onDetach: ((String) -> Void)?
	/// Where the first tab starts: right of the window buttons, or the bar's padding in full screen.
	var leadingInset: CGFloat = 88 {
		didSet { needsLayout = true }
	}

	private var tabs: [BrainTab] = []

	override var isFlipped: Bool { true }
	override var mouseDownCanMoveWindow: Bool { true }

	// AppKit drags the window for other clicks (mouseDownCanMoveWindow). In full screen there is nothing to zoom.
	override func mouseDown(with event: NSEvent) {
		guard event.clickCount == 2, let window, !window.styleMask.contains(.fullScreen) else { return super.mouseDown(with: event) }
		window.titleBarDoubleClicked(event)
	}

	/// Shows `brains` as tabs, `selected` marked.
	func update(brains: [Brain], selected: String?) {
		let organizations = Set(brains.compactMap(\.organization?.id))
		let grouped = organizations.count > 1
		let keep = tabs.map(\.brain) == brains
		if !keep {
			for tab in tabs { tab.removeFromSuperview() }
			tabs = brains.map { brain in
				let tab = BrainTab(brain: brain, organization: grouped ? brain.organization?.name : nil)
				tab.onSelect = { [weak self] id, modifiers in self?.onSelect?(id, modifiers) }
				tab.onDetach = { [weak self] id in self?.onDetach?(id) }
				addSubview(tab)
				return tab
			}
		}
		for tab in tabs { tab.selected = tab.brain.id == selected }
		needsLayout = true
	}

	override func layout() {
		super.layout()
		var x = leadingInset
		for tab in tabs {
			let width = tab.intrinsicContentSize.width
			tab.frame = NSRect(x: x, y: 0, width: width, height: bounds.height)
			x += width + ElanorTabs.gap
		}
	}

	override func draw(_ dirtyRect: NSRect) {
		ElanorTabs.canvas.setFill()
		bounds.fill()
		ElanorTabs.rule.setFill()
		NSRect(x: 0, y: bounds.height - ElanorTabs.line, width: bounds.width, height: ElanorTabs.line).fill()
	}
}

/// One tab: status dot, the organization when several share the bar, the brain's label; the selected tab's
/// indicator and the hover line sit on the bar's rule, as in Elanor.
@MainActor
private final class BrainTab: NSView {
	let brain: Brain
	var onSelect: ((String, NSEvent.ModifierFlags) -> Void)?
	var onDetach: ((String) -> Void)?
	var selected = false {
		didSet { if selected != oldValue { needsDisplay = true } }
	}

	private let organization: String?
	private var hovered = false
	private var pressed: NSPoint?
	private var detached = false

	init(brain: Brain, organization: String?) {
		self.brain = brain
		self.organization = organization
		super.init(frame: .zero)
		toolTip = brain.organization.map { "\($0.name) · \(brain.id)" } ?? "This Mac"
		setAccessibilityRole(.radioButton)
		setAccessibilityLabel([organization, brain.label, Self.statusText(brain.status)].compactMap { $0 }.joined(separator: ", "))
		addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) { fatalError("not used") }

	override var isFlipped: Bool { true }
	override var mouseDownCanMoveWindow: Bool { false }

	override var intrinsicContentSize: NSSize {
		NSSize(width: ceil(text.size().width) + ElanorTabs.dot + ElanorTabs.dotGap + (brain.isDirect ? ElanorTabs.markWidth : 0), height: BrainTabBar.height)
	}

	private var away: Bool { brain.status != .online }

	private var text: NSAttributedString {
		let color = away ? ElanorTabs.secondaryText : ElanorTabs.text
		let result = NSMutableAttributedString()
		if let organization {
			result.append(NSAttributedString(string: organization, attributes: [.font: ElanorTabs.font, .foregroundColor: ElanorTabs.secondaryText]))
			result.append(NSAttributedString(string: " / ", attributes: [.font: ElanorTabs.font, .foregroundColor: ElanorTabs.border]))
		}
		result.append(NSAttributedString(string: brain.label, attributes: [.font: ElanorTabs.font, .foregroundColor: color]))
		return result
	}

	override func draw(_ dirtyRect: NSRect) {
		let middle = bounds.height / 2
		let dot = NSRect(x: 0, y: middle - ElanorTabs.dot / 2, width: ElanorTabs.dot, height: ElanorTabs.dot)
		ElanorTabs.statusColor(brain.status).setFill()
		NSBezierPath(ovalIn: dot).fill()
		let label = text
		let size = label.size()
		let x = ElanorTabs.dot + ElanorTabs.dotGap
		label.draw(at: NSPoint(x: x, y: middle - size.height / 2))
		// This Mac's brain: reached directly, not through Radius.
		if brain.isDirect, let mark = NSImage(systemSymbolName: "laptopcomputer", accessibilityDescription: "On this Mac") {
			let configured = mark.withSymbolConfiguration(.init(pointSize: 11, weight: .regular)) ?? mark
			let tinted = NSImage(size: configured.size, flipped: false) { rect in
				configured.draw(in: rect)
				ElanorTabs.secondaryText.set()
				rect.fill(using: .sourceAtop)
				return true
			}
			tinted.draw(at: NSPoint(x: x + ceil(size.width) + 6, y: middle - configured.size.height / 2), from: .zero, operation: .sourceOver, fraction: 1)
		}
		if selected || hovered {
			(selected ? ElanorTabs.indicator : ElanorTabs.border).setFill()
			NSRect(x: 0, y: bounds.height - ElanorTabs.line, width: bounds.width, height: ElanorTabs.line).fill()
		}
	}

	override func mouseEntered(with event: NSEvent) {
		hovered = true
		needsDisplay = true
	}

	override func mouseExited(with event: NSEvent) {
		hovered = false
		needsDisplay = true
	}

	override func mouseDown(with event: NSEvent) {
		pressed = convert(event.locationInWindow, from: nil)
		detached = false
	}

	// Dragging a tab well below the bar (or above the window) tears it off into a window of its own.
	override func mouseDragged(with event: NSEvent) {
		guard !detached, let superview else { return }
		let point = superview.convert(event.locationInWindow, from: nil)
		if point.y > superview.bounds.height + 24 || point.y < -24 {
			detached = true
			onDetach?(brain.id)
		}
	}

	override func mouseUp(with event: NSEvent) {
		defer { pressed = nil }
		guard pressed != nil, !detached, bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
		onSelect?(brain.id, event.modifierFlags)
	}

	override func otherMouseUp(with event: NSEvent) {
		if event.buttonNumber == 2 { onSelect?(brain.id, .command) }
	}

	override func accessibilityPerformPress() -> Bool {
		onSelect?(brain.id, [])
		return true
	}

	private static func statusText(_ status: Brain.Status) -> String {
		switch status {
		case .online: "Online"
		case .offline: "Offline"
		case .unknown: "Status unknown"
		}
	}
}

/// Elanor's tab look (design-tokens, Radius theme), light and dark: `.tabs-module_*` in elanor.min.css.
@MainActor
enum ElanorTabs {
	/// `--semantic-typography-ui-primary`: Inter 14, the system font where Inter is not installed.
	static let font = NSFont(name: "Inter", size: 14) ?? .systemFont(ofSize: 14)
	/// `--semantic-dimension-space-control-gap-x-large`.
	static let gap: CGFloat = 16
	/// `--semantic-dimension-border-width-default`: the bar's rule, the indicator, the hover line.
	static let line: CGFloat = 2
	/// The shell's status dot and its gap (`--semantic-dimension-space-control-gap-small`).
	static let dot: CGFloat = 8
	static let dotGap: CGFloat = 6
	static let markWidth: CGFloat = 22

	/// `--semantic-color-background-canvas` (graphite-25 / graphite-900).
	static let canvas = dynamic(light: 0xF8F8F8, dark: 0x161616)
	/// `--semantic-color-text-primary` (black / white).
	static let text = dynamic(light: 0x111111, dark: 0xF6F6F6)
	/// `--semantic-color-text-secondary` (graphite-600 / graphite-300): away tabs, the organization.
	static let secondaryText = dynamic(light: 0x5E5E5E, dark: 0xACACAC)
	/// `--semantic-color-border-primary` (graphite-500 / graphite-400): the indicator and the hover line.
	static let indicator = dynamic(light: 0x777777, dark: 0x919191)
	static let border = indicator
	/// `--semantic-color-border-secondary` (graphite-100 / graphite-700): the bar's rule.
	static let rule = dynamic(light: 0xE2E2E2, dark: 0x464646)

	/// The shell's StatusDot: positive, secondary icon, warning.
	static func statusColor(_ status: Brain.Status) -> NSColor {
		switch status {
		case .online: dynamic(light: 0x2E6C4D, dark: 0x7FBF9C)
		case .offline: secondaryText
		case .unknown: dynamic(light: 0xB7791F, dark: 0xE0B05A)
		}
	}

	private static func dynamic(light: UInt32, dark: UInt32) -> NSColor {
		NSColor(name: nil) { appearance in
			let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
			return NSColor(
				srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255,
				alpha: 1)
		}
	}
}
