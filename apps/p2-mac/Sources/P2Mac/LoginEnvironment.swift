// The user's login shell environment. An app started from Finder or launchd gets a minimal one (PATH without Homebrew,
// nvm or ~/.local/bin), so p2's tools, MCP servers and Node itself would be missing. Read it once, as VS Code does.
import Foundation

enum LoginEnvironment {
	/// The login shell's environment; the app's own (with common tool paths) when the shell does not answer in time.
	static func capture() async -> [String: String] {
		await withCheckedContinuation { continuation in
			DispatchQueue.global(qos: .userInitiated).async {
				continuation.resume(returning: (try? read()) ?? fallback())
			}
		}
	}

	/// The first executable `name` on `path` (a PATH value).
	static func which(_ name: String, path: String?) -> String? {
		for directory in (path ?? "").split(separator: ":") {
			let candidate = "\(directory)/\(name)"
			if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
		}
		return nil
	}

	private static let marker = "__P2MAC_ENV__"
	private static let timeout: TimeInterval = 8

	private static func read() throws -> [String: String]? {
		let process = Process()
		process.executableURL = URL(fileURLWithPath: shell())
		// Interactive too: many users set PATH in .zshrc, which a login shell alone does not read.
		process.arguments = ["-l", "-i", "-c", "printf \(marker); /usr/bin/env -0; printf \(marker)"]
		let output = Pipe()
		process.standardOutput = output
		process.standardError = FileHandle.nullDevice
		process.standardInput = FileHandle.nullDevice
		try process.run()
		let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
		DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: timer)
		let data = output.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		timer.cancel()
		let parts = String(decoding: data, as: UTF8.self).components(separatedBy: marker)
		guard parts.count >= 3 else { return nil }
		var environment: [String: String] = [:]
		for entry in parts[1].split(separator: "\0") {
			guard let equals = entry.firstIndex(of: "=") else { continue }
			environment[String(entry[..<equals])] = String(entry[entry.index(after: equals)...])
		}
		// Shell bookkeeping that would only confuse p2's own shells.
		for key in ["SHLVL", "PWD", "OLDPWD", "_"] { environment.removeValue(forKey: key) }
		return environment["PATH"] == nil ? nil : environment
	}

	private static func shell() -> String {
		if let entry = getpwuid(getuid()), let shell = entry.pointee.pw_shell { return String(cString: shell) }
		return "/bin/zsh"
	}

	private static func fallback() -> [String: String] {
		var environment = ProcessInfo.processInfo.environment
		let home = FileManager.default.homeDirectoryForCurrentUser.path
		let extra = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin"]
		environment["PATH"] = (extra + [environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
		return environment
	}
}
