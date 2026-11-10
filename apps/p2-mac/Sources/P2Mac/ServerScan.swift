// Finds the p2 servers running on this Mac for the current user, so the app can use one of them (a dev checkout's)
// instead of starting its own: Node processes listening on loopback that answer p2's `/health`, with the data
// directory and checkout each one runs with.
import Darwin
import Foundation

struct FoundServer: Equatable {
	let port: Int
	let pid: Int32
	/// `P2_DATA_DIR` of the process, else p2's default.
	let dataDir: URL
	/// The process's working directory: the `apps/p2` it runs from.
	let checkout: URL?
	/// Its dev supervisor's control socket exists: the app can restart it.
	let dev: Bool
}

enum ServerScan {
	/// The p2 servers listening on 127.0.0.1, by port.
	static func scan() async -> [FoundServer] {
		let listeners = await Task.detached { listeningNodePorts() }.value
		return await withTaskGroup(of: FoundServer?.self) { group in
			for (pid, port) in listeners {
				group.addTask {
					guard await isP2(port: port) else { return nil }
					let environment = processEnvironment(pid)
					let dataDir = environment["P2_DATA_DIR"].map { URL(fileURLWithPath: $0) } ?? ServerConfig.defaultDataDir
					return FoundServer(
						port: port, pid: pid, dataDir: dataDir, checkout: workingDirectory(pid),
						dev: DevControl.available(dataDir: dataDir))
				}
			}
			var found: [FoundServer] = []
			for await server in group { if let server { found.append(server) } }
			return found.sorted { $0.port < $1.port }
		}
	}

	/// (pid, port) of this user's `node` processes listening on 127.0.0.1, from lsof.
	private static func listeningNodePorts() -> [(Int32, Int)] {
		let process = Process()
		process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
		process.arguments = ["-nP", "-a", "-iTCP@127.0.0.1", "-sTCP:LISTEN", "-u", String(getuid()), "-c", "node", "-F", "pn"]
		let output = Pipe()
		process.standardOutput = output
		process.standardError = FileHandle.nullDevice
		guard (try? process.run()) != nil else { return [] }
		let data = output.fileHandleForReading.readDataToEndOfFile()
		process.waitUntilExit()
		var result: [(Int32, Int)] = []
		var pid: Int32 = 0
		for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
			if line.hasPrefix("p") { pid = Int32(line.dropFirst()) ?? 0 }
			if line.hasPrefix("n"), let colon = line.lastIndex(of: ":"), let port = Int(line[line.index(after: colon)...]) {
				result.append((pid, port))
			}
		}
		return result
	}

	private static let probe: URLSession = {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = 0.8
		return URLSession(configuration: configuration)
	}()

	private static func isP2(port: Int) async -> Bool {
		guard let url = URL(string: "http://127.0.0.1:\(port)/health"),
			let (data, response) = try? await probe.data(from: url),
			(response as? HTTPURLResponse)?.statusCode == 200,
			let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return false }
		return body["name"] as? String == "p2"
	}

	/// The environment a process of this user started with (`KERN_PROCARGS2`).
	private static func processEnvironment(_ pid: Int32) -> [String: String] {
		var mib = [CTL_KERN, KERN_PROCARGS2, pid]
		var size = 0
		guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return [:] }
		var buffer = [UInt8](repeating: 0, count: size)
		guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return [:] }
		// Layout: argc, the executable path, padding NULs, argc arguments, then the environment, each NUL-terminated.
		let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
		let strings = buffer[4..<size].split(separator: 0, omittingEmptySubsequences: true)
			.map { String(decoding: $0, as: UTF8.self) }
		var environment: [String: String] = [:]
		for entry in strings.dropFirst(1 + Int(argc)) {
			guard let equals = entry.firstIndex(of: "=") else { continue }
			environment[String(entry[..<equals])] = String(entry[entry.index(after: equals)...])
		}
		return environment
	}

	private static func workingDirectory(_ pid: Int32) -> URL? {
		var info = proc_vnodepathinfo()
		let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
		guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
		let path = withUnsafeBytes(of: info.pvi_cdir.vip_path) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
		return path.isEmpty ? nil : URL(fileURLWithPath: path)
	}
}
