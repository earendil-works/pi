// Local owner sign-in, as p2's TUI does it (apps/p2/src/runtime/local-owner.ts): the app runs as the server's user, so
// it can read `<data>/owner-key`. It asks for a one-time challenge and answers with an HMAC of it and the port; the key
// never leaves the app. The answer earns p2's local owner cookie, which goes into the brain's webview cookie store.
import CryptoKit
import Foundation

enum LocalSignInError: LocalizedError {
	case noKey(String)
	case refused(String)

	var errorDescription: String? {
		switch self {
		case .noKey(let message), .refused(let message): message
		}
	}
}

enum LocalSignIn {
	/// The local owner session cookie of the p2 at `origin`, signed in with the owner key of `dataDir`.
	static func cookie(origin: URL, dataDir: URL) async throws -> HTTPCookie {
		let keyFile = dataDir.appending(path: "owner-key")
		guard let key = try? String(contentsOf: keyFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
		else { throw LocalSignInError.noKey("Cannot read \(keyFile.path)") }
		let port = origin.port ?? 80
		let (body, challenged) = try await post(origin, path: "/owner/local/challenge", json: [:])
		guard challenged.statusCode == 200,
			let challenge = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["challenge"] as? String
		else { throw LocalSignInError.refused("The server at \(origin.absoluteString) offers no local sign-in (\(challenged.statusCode))") }
		let proof = HMAC<SHA256>.authenticationCode(
			for: Data("p2-local-owner:\(port):\(challenge)".utf8),
			using: SymmetricKey(data: Data(key.utf8))
		).map { String(format: "%02x", $0) }.joined()
		let (_, claimed) = try await post(origin, path: "/owner/local/claim", json: ["challenge": challenge, "proof": proof])
		if claimed.statusCode == 403 {
			throw LocalSignInError.refused("The server at \(origin.absoluteString) does not use the data directory \(dataDir.path)")
		}
		let headers = claimed.allHeaderFields.reduce(into: [String: String]()) { result, field in
			if let name = field.key as? String, let value = field.value as? String { result[name] = value }
		}
		guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: origin)
			.first(where: { $0.name == "p2_owner_\(port)" })
		else { throw LocalSignInError.refused("Local sign-in at \(origin.absoluteString) failed (\(claimed.statusCode))") }
		return cookie
	}

	// Cookies are taken from the answer by hand: they belong in the webview's store, not in a shared one.
	private static let session: URLSession = {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpShouldSetCookies = false
		configuration.httpCookieAcceptPolicy = .never
		configuration.timeoutIntervalForRequest = 5
		return URLSession(configuration: configuration)
	}()

	/// A same-origin JSON POST, as p2's sign-in routes require.
	private static func post(_ origin: URL, path: String, json: [String: String]) async throws -> (Data, HTTPURLResponse) {
		var request = URLRequest(url: URL(string: path, relativeTo: origin)!.absoluteURL)
		request.httpMethod = "POST"
		request.setValue(origin.absoluteString.trimmingCharacters(in: ["/"]), forHTTPHeaderField: "Origin")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: json)
		let (data, response) = try await session.data(for: request)
		return (data, response as! HTTPURLResponse)
	}
}
