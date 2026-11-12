// The local p2 server: uses the one already running on the configured port, or runs one as a child process, and
// reports its state. (The product runs it as a LaunchAgent instead; this spike keeps it a child of the app.)
import Foundation

@MainActor
final class ServerController {
	enum Phase: Equatable {
		case checking
		case stopped
		case starting
		case running
		case stopping
		case failed(String)
	}

	/// Who runs the server: this app (it may stop it), someone else (the owner's checkout in a terminal), or nobody.
	enum Ownership: Equatable {
		case none
		case managed
		case external
	}

	private(set) var phase: Phase = .checking
	private(set) var ownership: Ownership = .none
	let config: ServerConfig
	let logFile: URL
	/// Called on the main actor after every change of `phase` or `ownership`.
	var onChange: (() -> Void)?

	/// The server this app runs, by pid: one it started, or one an earlier run of the app started and left behind (a
	/// crash, a kill), found again through the pid file so it is still the app's to stop.
	private var child: Int32?
	/// The process object of a server this run started; nil for one found through the pid file.
	private var launched: Process?
	private let pidFile: URL
	private var startedAt: Date?
	/// `start` is between its first line and the launch (reading the login environment): no second start, and no poll
	/// may report the not yet launched server as stopped.
	private var launching = false
	private var restartAfterExit = false
	private var restartingExternal = false
	private var polling = false
	private var environment: [String: String]?
	private var timer: Timer?

	init(config: ServerConfig) {
		self.config = config
		logFile = FileManager.default.homeDirectoryForCurrentUser
			.appending(path: "Library/Logs/Pi/server-\(config.port).log")
		pidFile = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
			.appending(path: "Pi/server-\(config.port).pid")
		timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
			Task { @MainActor in await self?.poll() }
		}
	}

	var canStart: Bool {
		config.source == .own && config.checkout != nil && child == nil && !launching && ownership != .external
			&& (phase == .stopped || phase == .checking || isFailed)
	}

	var canStop: Bool { ownership == .managed && phase != .stopping }

	var canRestart: Bool {
		phase == .running && (ownership == .managed || DevControl.available(dataDir: config.dataDir))
	}

	private var isFailed: Bool {
		if case .failed = phase { return child == nil }
		return false
	}

	/// Stops watching the server; the app switched to another one.
	func invalidate() {
		timer?.invalidate()
		timer = nil
		onChange = nil
	}

	/// Probes the port and updates the state.
	func poll() async {
		guard !polling else { return }
		polling = true
		let healthy = await Self.healthy(config.origin)
		if healthy, child == nil, config.source == .own, let pid = recordedPID(), kill(pid, 0) == 0,
			await Self.listens(pid: pid, port: config.port)
		{
			child = pid
		}
		polling = false
		update(healthy: healthy)
	}

	/// Runs the configured checkout's server as a child process.
	func start() async {
		guard config.source == .own, child == nil, !launching, ownership != .external, let checkout = config.checkout else { return }
		launching = true
		defer { launching = false }
		set(.starting, .managed)
		if environment == nil { environment = await LoginEnvironment.capture() }
		var environment = environment ?? [:]
		environment["PORT"] = String(config.port)
		environment["P2_DATA_DIR"] = config.dataDir.path
		if config.fake { environment["P2_FAKE"] = "1" }
		guard let node = config.node ?? LoginEnvironment.which("node", path: environment["PATH"]) else {
			return set(.failed("No node on the login shell's PATH"), .none)
		}
		let process = Process()
		process.executableURL = URL(fileURLWithPath: node)
		process.arguments = ["--import", "./src/source.ts", config.mode == .dev ? "scripts/dev.mjs" : "src/hosts/server.ts"]
		process.currentDirectoryURL = checkout
		process.environment = environment
		process.standardInput = FileHandle.nullDevice
		do {
			let log = try openLog()
			log.write(Data("\n--- \(Date()) starting \(node) \(process.arguments!.joined(separator: " ")) in \(checkout.path)\n".utf8))
			process.standardOutput = log
			process.standardError = log
			process.terminationHandler = { [weak self] ended in
				let status = ended.terminationStatus
				let pid = ended.processIdentifier
				// Only the current server's exit: a stale handler must not forget a server started after it.
				Task { @MainActor in if self?.child == pid { self?.exited(status: status) } }
			}
			try process.run()
		} catch {
			return set(.failed("Could not start node: \(error.localizedDescription)"), .none)
		}
		child = process.processIdentifier
		launched = process
		startedAt = Date()
		try? FileManager.default.createDirectory(at: pidFile.deletingLastPathComponent(), withIntermediateDirectories: true)
		try? Data(String(process.processIdentifier).utf8).write(to: pidFile)
	}

	/// Stops the server this app runs: SIGTERM (p2 shuts down its workers), SIGKILL after 15 seconds.
	func stop() {
		guard let child, childRunning else { return }
		set(.stopping, .managed)
		kill(child, SIGTERM)
		// Not tied to this controller: a server must not outlive a switch to another one.
		DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
			if kill(child, 0) == 0 { kill(child, SIGKILL) }
		}
	}

	/// Restarts the server: ours by stopping and starting it, a dev-mode one through its supervisor.
	func restart() async {
		if ownership == .managed {
			restartAfterExit = true
			stop()
		} else if DevControl.available(dataDir: config.dataDir) {
			restartingExternal = true
			set(.starting, .external)
			_ = try? await DevControl.restart(dataDir: config.dataDir)
			restartingExternal = false
			await poll()
		}
	}

	/// Waits for a stopping child to exit, at most `seconds`; used when the app quits.
	func waitForExit(seconds: TimeInterval) async {
		let deadline = Date().addingTimeInterval(seconds)
		while childRunning, Date() < deadline { try? await Task.sleep(for: .milliseconds(100)) }
		if childRunning, let child {
			kill(child, SIGKILL)
			try? await Task.sleep(for: .milliseconds(300))
		}
		if !childRunning { try? FileManager.default.removeItem(at: pidFile) }
	}

	private var childRunning: Bool {
		if let launched { return launched.isRunning }
		return child.map { kill($0, 0) == 0 } ?? false
	}

	private func recordedPID() -> Int32? {
		(try? String(contentsOf: pidFile, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
	}

	private func update(healthy: Bool) {
		if launching { return }
		// A server found through the pid file has no termination handler: notice its exit here.
		if launched == nil, child != nil, !childRunning { return exited(status: 0) }
		if childRunning {
			if phase == .stopping { return }
			if healthy { return set(.running, .managed) }
			if let startedAt, Date().timeIntervalSince(startedAt) > 90 {
				return set(.failed("The server did not answer within 90 seconds"), .managed)
			}
			return set(.starting, .managed)
		}
		if healthy { return set(.running, .external) }
		if restartingExternal { return }
		if isFailed { return set(phase, .none) }
		set(.stopped, .none)
	}

	private func exited(status: Int32) {
		let expected = phase == .stopping
		child = nil
		launched = nil
		startedAt = nil
		try? FileManager.default.removeItem(at: pidFile)
		if restartAfterExit {
			restartAfterExit = false
			Task { await start() }
			return
		}
		set(expected ? .stopped : .failed("The server exited with status \(status); see its log"), .none)
	}

	private func set(_ phase: Phase, _ ownership: Ownership) {
		guard phase != self.phase || ownership != self.ownership else { return }
		self.phase = phase
		self.ownership = ownership
		onChange?()
	}

	private func openLog() throws -> FileHandle {
		try FileManager.default.createDirectory(at: logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
		if !FileManager.default.fileExists(atPath: logFile.path) {
			FileManager.default.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
		}
		let handle = try FileHandle(forWritingTo: logFile)
		handle.seekToEndOfFile()
		return handle
	}

	private static let probe: URLSession = {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = 1
		return URLSession(configuration: configuration)
	}()

	/// Whether process `pid` listens on `port` (lsof), so a pid from the pid file is still that server.
	private static func listens(pid: Int32, port: Int) async -> Bool {
		await Task.detached {
			let lsof = Process()
			lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
			lsof.arguments = ["-a", "-p", String(pid), "-iTCP:\(port)", "-sTCP:LISTEN", "-t"]
			let output = Pipe()
			lsof.standardOutput = output
			lsof.standardError = FileHandle.nullDevice
			guard (try? lsof.run()) != nil else { return false }
			let data = output.fileHandleForReading.readDataToEndOfFile()
			lsof.waitUntilExit()
			return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == String(pid)
		}.value
	}

	/// Whether a p2 answers its unauthenticated readiness probe at `origin`.
	private static func healthy(_ origin: URL) async -> Bool {
		guard let (data, response) = try? await probe.data(from: origin.appending(path: "health")),
			(response as? HTTPURLResponse)?.statusCode == 200,
			let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return false }
		return body["name"] as? String == "p2"
	}
}
