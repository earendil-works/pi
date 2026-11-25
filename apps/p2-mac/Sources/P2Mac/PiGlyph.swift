// The Pi logo's shape (apps/p2/src/web/PiLogo.tsx: five cells on a 4×4 grid), drawn in one colour for the menu bar.
import AppKit

enum PiGlyph {
	/// The logo's cells as (x, y, width, height) on its 4×4 grid, y downwards.
	static let cells: [CGRect] = [
		CGRect(x: 0, y: 0, width: 3, height: 1),
		CGRect(x: 2, y: 1, width: 1, height: 1),
		CGRect(x: 0, y: 1, width: 1, height: 3),
		CGRect(x: 1, y: 2, width: 1, height: 1),
		CGRect(x: 3, y: 2, width: 1, height: 2),
	]

	/// A template image of the logo, `size` points square: macOS tints it for the menu bar (black or white).
	static func templateImage(size: CGFloat) -> NSImage {
		let image = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
			let cell = rect.width / 4
			NSColor.black.setFill()
			for c in cells {
				NSRect(x: c.minX * cell, y: c.minY * cell, width: c.width * cell, height: c.height * cell).fill()
			}
			return true
		}
		image.isTemplate = true
		image.accessibilityDescription = "Pi"
		return image
	}
}
