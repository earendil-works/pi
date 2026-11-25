// Entry point: an AppKit app with AppDelegate as its delegate.
import AppKit

MainActor.assumeIsolated {
	let delegate = AppDelegate()
	NSApplication.shared.delegate = delegate
	NSApplication.shared.run()
}
