// Draws the app icon: the Pi logo (apps/p2/src/web/PiLogo.tsx and public/icons/favicon.svg, in its colours) on a white
// macOS icon plate, as an .iconset directory for iconutil. Usage: swift scripts/make-icon.swift <out.iconset>
import AppKit

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> NSColor {
	NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1)
}

let coral = rgb(228, 138, 122)
let blue = rgb(79, 142, 179)
let yellow = rgb(234, 182, 93)

/// The logo's cells on its 4×4 grid, y downwards, with their colours.
let cells: [(CGRect, NSColor)] = [
	(CGRect(x: 0, y: 0, width: 3, height: 1), coral),
	(CGRect(x: 2, y: 1, width: 1, height: 1), coral),
	(CGRect(x: 0, y: 1, width: 1, height: 3), blue),
	(CGRect(x: 1, y: 2, width: 1, height: 1), blue),
	(CGRect(x: 3, y: 2, width: 1, height: 2), yellow),
]

func png(pixels: Int) -> Data {
	let rep = NSBitmapImageRep(
		bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
		hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
	NSGraphicsContext.saveGraphicsState()
	NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
	let s = CGFloat(pixels) / 1024
	// Apple's grid: an 824 plate centred on the 1024 canvas, with room for its shadow.
	let plate = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
	let shadow = NSShadow()
	shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
	shadow.shadowBlurRadius = 20 * s
	shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
	NSGraphicsContext.saveGraphicsState()
	shadow.set()
	NSColor.white.setFill()
	NSBezierPath(roundedRect: plate, xRadius: 185 * s, yRadius: 185 * s).fill()
	NSGraphicsContext.restoreGraphicsState()
	let cell = 104 * s
	let origin = CGPoint(x: 512 * s - 2 * cell, y: 512 * s + 2 * cell)
	for (c, color) in cells {
		color.setFill()
		NSRect(x: origin.x + c.minX * cell, y: origin.y - c.maxY * cell, width: c.width * cell, height: c.height * cell).fill()
	}
	NSGraphicsContext.restoreGraphicsState()
	return rep.representation(using: .png, properties: [:])!
}

let out = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
	try png(pixels: size).write(to: out.appending(path: "icon_\(size)x\(size).png"))
	try png(pixels: size * 2).write(to: out.appending(path: "icon_\(size)x\(size)@2x.png"))
}
