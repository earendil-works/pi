// p2's dev supervisor control channel (apps/p2/src/hosts/dev-channel.ts): an HTTP POST on the private Unix socket
// `<data>/dev.sock`. The app restarts a dev-mode server it did not start (the owner's own checkout) through it.
import Foundation

enum DevControl {
	/// Whether a dev supervisor serves this data directory.
	static func available(dataDir: URL) -> Bool {
		FileManager.default.fileExists(atPath: socketPath(dataDir))
	}

	/// Asks the supervisor for a graceful restart; returns once the replacement is ready (or refused).
	static func restart(dataDir: URL) async throws -> String {
		let path = socketPath(dataDir)
		return try await Task.detached { try post(socket: path, body: #"{"action":"restart"}"#) }.value
	}

	private static func socketPath(_ dataDir: URL) -> String { dataDir.appending(path: "dev.sock").path }

	private static func post(socket path: String, body: String) throws -> String {
		let fd = socket(AF_UNIX, SOCK_STREAM, 0)
		guard fd >= 0 else { throw POSIXError(.init(rawValue: errno) ?? .EIO) }
		defer { close(fd) }
		var address = sockaddr_un()
		address.sun_family = sa_family_t(AF_UNIX)
		let bytes = Array(path.utf8)
		guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { throw POSIXError(.ENAMETOOLONG) }
		withUnsafeMutableBytes(of: &address.sun_path) { buffer in
			buffer.copyBytes(from: bytes)
			buffer[bytes.count] = 0
		}
		let connected = withUnsafePointer(to: &address) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
			}
		}
		guard connected == 0 else { throw POSIXError(.init(rawValue: errno) ?? .ECONNREFUSED) }
		// The supervisor answers once the replacement server is ready, which can take a while.
		var timeout = timeval(tv_sec: 120, tv_usec: 0)
		setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
		let request = Array(
			"POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
				.utf8)
		var sent = 0
		while sent < request.count {
			let written = request[sent...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
			guard written > 0 else { throw POSIXError(.EPIPE) }
			sent += written
		}
		var response = Data()
		var buffer = [UInt8](repeating: 0, count: 4096)
		while true {
			let count = read(fd, &buffer, buffer.count)
			if count <= 0 { break }
			response.append(buffer, count: count)
		}
		let text = String(decoding: response, as: UTF8.self)
		guard let separator = text.range(of: "\r\n\r\n") else { return text }
		return String(text[separator.upperBound...])
	}
}
