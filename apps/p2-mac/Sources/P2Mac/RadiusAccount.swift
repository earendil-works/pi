// The app's Radius account is this Mac's Pi's: one credential, in the Pi's `radius.json` on disk, shared 1:1. The Pi
// connects to Radius with it; the app lists the tabs with it (`GET /v1/pi/servers`, which takes any gateway bearer and
// covers the token's organization) and gets the grants that open other Pis on their forwarded origins. The app loads
// no Radius pages.
//
// - Sign in: as the Pi's own `radius:login`, but through the system browser (OAuth client `pi-gateway`, scope
//   `gateway offline_access`, PKCE, a loopback redirect; never inside a webview). The credential goes into radius.json,
//   keeping the Pi's server ID; the Pi connects with it within 30 seconds.
// - Refresh: Radius does not rotate refresh tokens, so the app and the Pi refresh the credential independently. The
//   app reads the file before every call and writes a refreshed token back; the Pi reads it again on every attempt.
// - Sign out: radius.json goes, which disconnects the Pi too.
import AppKit
import CryptoKit
import Foundation
import Security

@MainActor
final class RadiusAccount {
	static let changed = Notification.Name("P2MacRadiusAccountChanged")

	/// This Mac's Pi, whose radius.json holds the credential and which refreshes it while it runs.
	var server: ServerController {
		didSet { NotificationCenter.default.post(name: Self.changed, object: self) }
	}

	/// The credential Radius last refused (a dead refresh token): signed out until a new sign-in replaces it.
	private var refusedRefresh: String?
	private var refreshing: Task<Void, Error>?

	enum Failure: Error, LocalizedError {
		/// No usable credential: sign in (again).
		case signedOut(String)
		/// The user has no Pi shell (`pi_shell_not_enabled`).
		case notEnabled
		case http(Int, String)

		var errorDescription: String? {
			switch self {
			case .signedOut(let reason): "Signed out of Radius: \(reason)"
			case .notEnabled: "Pi is not enabled for this Radius account"
			case .http(let status, let error): "Radius answered \(status): \(error)"
			}
		}
	}

	private static let clientID = "pi-gateway"
	private static let scope = "gateway offline_access"
	/// Development against a fake gateway (P2MAC_SIGN_IN=headless): the app fetches the authorization page itself
	/// instead of opening the browser, and signs in at launch.
	let headless = ProcessInfo.processInfo.environment["P2MAC_SIGN_IN"] == "headless"
	/// The gateway new sign-ins use: `PI_RADIUS_GATEWAY` as for the CLIs, else production. A signed-in credential
	/// names its own.
	private let defaultGateway: URL = {
		let configured = ProcessInfo.processInfo.environment["PI_RADIUS_GATEWAY"] ?? "https://radius.pi.dev"
		return URL(string: configured.hasSuffix("/") ? String(configured.dropLast()) : configured)!
	}()

	init(server: ServerController) {
		self.server = server
	}

	private var file: URL { server.config.dataDir.appending(path: "radius.json") }

	/// radius.json as written (p2's `RadiusBrainConfig`): gateway, serverId, credential, and the Pi's own fields.
	private func stored() -> [String: Any]? {
		guard let data = try? Data(contentsOf: file) else { return nil }
		return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
	}

	private func credential(_ config: [String: Any]?) -> [String: Any]? {
		guard let credential = config?["credential"] as? [String: Any], credential["access"] is String, credential["refresh"] is String
		else { return nil }
		return credential
	}

	var signedIn: Bool {
		guard let credential = credential(stored()) else { return false }
		return refusedRefresh != credential["refresh"] as? String
	}

	var gateway: URL {
		(stored()?["gateway"] as? String).flatMap(URL.init(string:)) ?? defaultGateway
	}

	// MARK: - Sign-in

	/// Signs in through the system browser and writes the credential into radius.json.
	func signIn() async throws {
		let gateway = defaultGateway
		let discovery = try await json(URLRequest(url: gateway.appending(path: "v1/oauth")))
		// HTTPS, or plain HTTP to a gateway on this machine (development).
		guard let endpoint = (discovery["authorizationEndpoint"] as? String).flatMap(URL.init(string:)),
			endpoint.scheme == "https" || (endpoint.scheme == "http" && ["127.0.0.1", "localhost"].contains(endpoint.host))
		else { throw Failure.http(0, "no authorization endpoint") }
		let verifier = Self.randomURLSafe(bytes: 48)
		let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
		let state = Self.randomURLSafe(bytes: 24)
		let loopback = try await OAuthLoopback.start()
		defer { loopback.stop() }
		var authorize = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
		authorize.queryItems = [
			.init(name: "response_type", value: "code"),
			.init(name: "client_id", value: Self.clientID),
			.init(name: "redirect_uri", value: loopback.redirectURI.absoluteString),
			.init(name: "scope", value: Self.scope),
			.init(name: "code_challenge", value: challenge),
			.init(name: "code_challenge_method", value: "S256"),
			.init(name: "handoff", value: "url"),
			.init(name: "state", value: state),
		]
		if headless {
			Task { _ = try? await Self.session.data(from: authorize.url!) }
		} else {
			NSWorkspace.shared.open(authorize.url!)
		}
		let callback = try await loopback.callback()
		let query = Dictionary(callback.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { a, _ in a })
		guard query["state"] == state else { throw Failure.http(0, "the sign-in answered for another request") }
		if let error = query["error"] { throw Failure.http(0, query["error_description"] ?? error) }
		guard let code = query["code"] else { throw Failure.http(0, "the sign-in returned no code") }
		let credential = try await token(
			gateway,
			[
				"grant_type": "authorization_code", "client_id": Self.clientID, "redirect_uri": loopback.redirectURI.absoluteString,
				"code": code, "code_verifier": verifier,
			])
		// As p2's `radius:login`: the same gateway keeps the Pi's server ID (and what it learned), another starts anew.
		var config = stored() ?? [:]
		if config["gateway"] as? String != gateway.absoluteString {
			config = ["serverId": UUID().uuidString.lowercased()]
		}
		config["gateway"] = gateway.absoluteString
		config["credential"] = credential
		try write(config)
		refusedRefresh = nil
		NotificationCenter.default.post(name: Self.changed, object: self)
	}

	/// Removes the credential, which signs the app out and disconnects this Mac's Pi (the caller clears the Radius
	/// pages' cookies).
	func signOut() {
		try? FileManager.default.removeItem(at: file)
		refreshing?.cancel()
		refreshing = nil
		NotificationCenter.default.post(name: Self.changed, object: self)
	}

	// MARK: - Calls

	/// The Pi servers of the token's organization (`/v1/pi/servers`, the shell's `/pi/api/brains` shape), for the tabs.
	func servers() async throws -> Data {
		try await authorized(URLRequest(url: gateway.appending(path: "v1/pi/servers")))
	}

	/// A one-minute grant URL that opens `path` (an address of the Pi's UI) on the Pi's forwarded origin
	/// (`https://<label>.rdtun.com`) and leaves a view cookie there.
	func openURL(organization: String, server: String, path: String) async throws -> URL {
		var components = URLComponents(url: gateway.appending(path: "v1/pi/servers/\(organization)/\(server)/open"), resolvingAgainstBaseURL: false)!
		components.queryItems = [URLQueryItem(name: "path", value: path)]
		var request = URLRequest(url: components.url!)
		request.httpMethod = "POST"
		let body = try JSONSerialization.jsonObject(with: try await authorized(request)) as? [String: Any]
		// HTTPS, or plain HTTP on this machine (development against a fake Radius).
		guard let url = (body?["url"] as? String).flatMap(URL.init(string:)),
			url.scheme == "https" || (url.scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host))
		else {
			throw Failure.http(200, "no grant URL")
		}
		return url
	}

	/// `request` with the current access token; on a 401 one refresh and a retry.
	private func authorized(_ request: URLRequest) async throws -> Data {
		var retried = false
		while true {
			var signed = request
			signed.setValue("Bearer \(try await accessToken(force: retried))", forHTTPHeaderField: "Authorization")
			signed.setValue("application/json", forHTTPHeaderField: "Accept")
			let (data, response) = try await Self.session.data(for: signed)
			let status = (response as? HTTPURLResponse)?.statusCode ?? 0
			if (200..<300).contains(status) { return data }
			let error = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? "error"
			if status == 401, !retried {
				retried = true
				continue
			}
			if status == 401 { throw Failure.signedOut(error) }
			if status == 404 && error == "pi_shell_not_enabled" { throw Failure.notEnabled }
			throw Failure.http(status, error)
		}
	}

	/// The access token in radius.json, refreshed first when it is about to expire (or `force`). One refresh at a time.
	private func accessToken(force: Bool = false) async throws -> String {
		guard let credential = credential(stored()), let access = credential["access"] as? String else {
			throw Failure.signedOut("not signed in")
		}
		let expires = Date(timeIntervalSince1970: ((credential["expires"] as? Double) ?? 0) / 1000)
		if !force, expires.timeIntervalSinceNow > 60 { return access }
		if refreshing == nil {
			refreshing = Task { try await refresh() }
		}
		do {
			try await refreshing!.value
			refreshing = nil
		} catch {
			refreshing = nil
			throw error
		}
		guard let fresh = self.credential(stored())?["access"] as? String else { throw Failure.signedOut("not signed in") }
		return fresh
	}

	private func refresh() async throws {
		guard var config = stored(), let credential = credential(config), let refresh = credential["refresh"] as? String else {
			throw Failure.signedOut("not signed in")
		}
		do {
			config["credential"] = try await token(gateway, ["grant_type": "refresh_token", "client_id": Self.clientID, "refresh_token": refresh])
		} catch Failure.http(let status, let reason) where (400..<500).contains(status) {
			refusedRefresh = refresh
			NotificationCenter.default.post(name: Self.changed, object: self)
			throw Failure.signedOut(reason)
		}
		// The file again: the Pi may have written meanwhile (what it learned about itself); only the credential is ours.
		var latest = stored() ?? config
		latest["credential"] = config["credential"]
		try write(latest)
	}

	/// pi-ai's OAuthCredential, as p2 stores it: `{ type, access, refresh, expires (ms), scope }`.
	private func token(_ gateway: URL, _ form: [String: String]) async throws -> [String: Any] {
		var request = URLRequest(url: gateway.appending(path: "v1/oauth/token"))
		request.httpMethod = "POST"
		request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
		var body = URLComponents()
		body.queryItems = form.map { URLQueryItem(name: $0.key, value: $0.value) }
		request.httpBody = Data((body.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").utf8)
		let answer = try await json(request)
		guard let access = answer["access_token"] as? String, let refresh = answer["refresh_token"] as? String,
			let expiresIn = answer["expires_in"] as? Double
		else { throw Failure.http(200, "incomplete token response") }
		var credential: [String: Any] = [
			"type": "oauth", "access": access, "refresh": refresh,
			"expires": (Date().timeIntervalSince1970 + expiresIn - 60) * 1000,
		]
		if let scope = answer["scope"] as? String { credential["scope"] = scope }
		return credential
	}

	/// Writes radius.json as p2 does: private (0600), through a temporary file and a rename.
	private func write(_ config: [String: Any]) throws {
		try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
		let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
		let temporary = file.appendingPathExtension("tmp")
		guard FileManager.default.createFile(atPath: temporary.path, contents: data + Data("\n".utf8), attributes: [.posixPermissions: 0o600]),
			rename(temporary.path, file.path) == 0
		else { throw Failure.http(0, "cannot write \(file.path)") }
	}

	private func json(_ request: URLRequest) async throws -> [String: Any] {
		var request = request
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		let (data, response) = try await Self.session.data(for: request)
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
		guard (200..<300).contains(status), let object else {
			throw Failure.http(status, (object?["error_description"] ?? object?["error"]) as? String ?? "unexpected answer")
		}
		return object
	}

	private static let session: URLSession = {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = 15
		return URLSession(configuration: configuration)
	}()

	private static func randomURLSafe(bytes: Int) -> String {
		var data = Data(count: bytes)
		_ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
		return data.base64URL
	}
}

extension Data {
	/// Base64url without padding (RFC 4648 §5), as PKCE and OAuth state use.
	var base64URL: String {
		base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
			.replacingOccurrences(of: "=", with: "")
	}
}
