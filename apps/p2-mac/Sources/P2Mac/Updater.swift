// Updates of packaged builds through Sparkle: it reads the appcast at SUFeedURL, checks the EdDSA signature against
// SUPublicEDKey and replaces the app. scripts/package-app.sh writes both keys; a development build has neither and no
// updater.
import AppKit
import Sparkle

@MainActor
final class Updater: NSObject, SPUStandardUserDriverDelegate {
	private var controller: SPUStandardUpdaterController?

	override init() {
		super.init()
		guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil else { return }
		controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: self)
	}

	/// Whether this build updates itself.
	var available: Bool { controller != nil }

	/// Checks for an update now and shows the result.
	func checkForUpdates() {
		NSApp.activate()
		controller?.checkForUpdates(nil)
	}

	// A menu bar app is rarely in front: Sparkle's scheduled update window would open behind other apps' windows.
	nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

	nonisolated func standardUserDriverWillHandleShowingUpdate(
		_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState
	) {
		if handleShowingUpdate { MainActor.assumeIsolated { NSApp.activate() } }
	}
}
