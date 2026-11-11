// The OAuth redirect target of a native sign-in (RFC 8252): a one-shot HTTP listener on 127.0.0.1 with a port the
// system picks. The browser lands on it with `code` and `state` after the user approved the sign-in.
import Foundation
import Network

@MainActor
final class OAuthLoopback {
	/// The redirect URI to register with the authorization request.
	let redirectURI: URL
	private let listener: NWListener
	private var continuation: CheckedContinuation<URLComponents, Error>?

	private static let path = "/oauth/callback"

	/// Listens on a free loopback port; the redirect URI names it.
	static func start() async throws -> OAuthLoopback {
		let parameters = NWParameters.tcp
		parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
		let listener = try NWListener(using: parameters)
		let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
			// Handlers run on the main queue (start(queue:)), one at a time.
			nonisolated(unsafe) var resumed = false
			listener.stateUpdateHandler = { state in
				guard !resumed else { return }
				switch state {
				case .ready:
					resumed = true
					continuation.resume(returning: listener.port?.rawValue ?? 0)
				case .failed(let error):
					resumed = true
					continuation.resume(throwing: error)
				default: break
				}
			}
			listener.newConnectionHandler = { $0.cancel() }
			listener.start(queue: .main)
		}
		return OAuthLoopback(listener: listener, port: port)
	}

	private init(listener: NWListener, port: UInt16) {
		self.listener = listener
		redirectURI = URL(string: "http://127.0.0.1:\(port)\(Self.path)")!
		listener.newConnectionHandler = { [weak self] connection in
			MainActor.assumeIsolated { self?.accept(connection) }
		}
	}

	/// The callback's query, once the browser arrives; throws when cancelled or after `timeout`.
	func callback(timeout: Duration = .seconds(600)) async throws -> URLComponents {
		try await withThrowingTaskGroup(of: URLComponents.self) { group in
			group.addTask { @MainActor in
				try await withCheckedThrowingContinuation { self.continuation = $0 }
			}
			group.addTask {
				try await Task.sleep(for: timeout)
				throw URLError(.timedOut)
			}
			defer { group.cancelAll() }
			return try await group.next()!
		}
	}

	func stop() {
		listener.cancel()
		continuation?.resume(throwing: CancellationError())
		continuation = nil
	}

	private func accept(_ connection: NWConnection) {
		connection.start(queue: .main)
		connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
			MainActor.assumeIsolated {
				let line = data.flatMap { String(data: $0, encoding: .utf8) }?.split(separator: "\r\n").first ?? ""
				let target = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""
				let components = URLComponents(string: "http://127.0.0.1\(target)")
				let ours = components?.path == Self.path
				let body = ours
					? "<!doctype html><meta charset=utf-8><title>Pi</title><body style=\"font: 15px -apple-system; margin: 4em; text-align: center\">Signed in to Radius. You can close this tab and return to Pi."
					: "Not found"
				let response = "HTTP/1.1 \(ours ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n\(body)"
				connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
				if ours, let components, let continuation = self?.continuation {
					self?.continuation = nil
					continuation.resume(returning: components)
				}
			}
		}
	}
}
