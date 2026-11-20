// Copies p2's data directory aside before a new build of the app's own p2 first runs on it. p2's data formats change
// without notice and a packaged app updates itself, so a failed migration must not cost anyone their sessions.
import Foundation

enum DataBackup {
	/// How many backups of a data directory to keep, newest first.
	private static let kept = 3

	/// Backs up `dataDir` when this app's build differs from the build that last ran the app's own p2 on it, then
	/// records this build. Returns a line for the server log, or nil when there was nothing to back up.
	static func beforeUpgrade(dataDir: URL) async -> String? {
		let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
		let key = "lastBuild:\(dataDir.path)"
		let previous = UserDefaults.standard.string(forKey: key)
		UserDefaults.standard.set(build, forKey: key)
		guard let previous, previous != build, FileManager.default.fileExists(atPath: dataDir.path) else { return nil }
		return await Task.detached { copy(dataDir, build: previous) }.value
	}

	/// Copies `dataDir` to `<dataDir>.backups/<build>` (an APFS clone, so cheap) and prunes old backups.
	private static func copy(_ dataDir: URL, build: String) -> String {
		let backups = dataDir.deletingLastPathComponent().appending(path: "\(dataDir.lastPathComponent).backups")
		let target = backups.appending(path: build)
		do {
			try FileManager.default.createDirectory(at: backups, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
			if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
		} catch {
			return "data backup failed: \(error.localizedDescription)"
		}
		// cp, not FileManager: it skips sockets (a dev server's dev.sock) instead of failing the whole copy.
		let cp = Process()
		cp.executableURL = URL(fileURLWithPath: "/bin/cp")
		cp.arguments = ["-c", "-R", "-p", dataDir.path, target.path]
		cp.standardOutput = FileHandle.nullDevice
		cp.standardError = FileHandle.nullDevice
		do {
			try cp.run()
			cp.waitUntilExit()
		} catch {
			return "data backup failed: \(error.localizedDescription)"
		}
		prune(backups)
		let outcome = cp.terminationStatus == 0 ? "backed up" : "partly backed up (cp exited with \(cp.terminationStatus))"
		return "data from build \(build) \(outcome) to \(target.path)"
	}

	private static func prune(_ backups: URL) {
		let entries = (try? FileManager.default.contentsOfDirectory(at: backups, includingPropertiesForKeys: [.creationDateKey])) ?? []
		let created = { (url: URL) in (try? url.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast }
		for old in entries.sorted(by: { created($0) > created($1) }).dropFirst(kept) {
			try? FileManager.default.removeItem(at: old)
		}
	}
}
