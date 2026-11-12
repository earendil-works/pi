// A brain the app shows: one Pi server, as a tab of the window's tab bar and a page under it.
import CryptoKit
import Foundation

struct Brain: Equatable {
	struct Organization: Equatable, Decodable {
		let id: String
		let name: String
	}

	enum Status: String {
		case online
		case offline
		case unknown
	}

	/// How the app reaches the brain.
	enum Route: Equatable {
		/// This Mac's server, on loopback, signed in with the owner key of its data directory.
		case direct(origin: URL, dataDir: URL)
		/// Another Pi: its UI from Radius's forwarded origin for it (`https://<label>.rdtun.com`), loaded as the page
		/// itself through a one-minute grant the app gets with the shared Radius credential.
		case remote(organization: String, server: String)
	}

	/// The Radius server ID, or `local-<port>` for a local brain Radius does not list.
	let id: String
	let name: String
	/// Nil for a local brain Radius does not list.
	let organization: Organization?
	/// Someone else's brain, shared with this user.
	let shared: Bool
	let status: Status
	let route: Route

	/// The tab's text, as the Radius shell labels it (`brainLabel`).
	var label: String { shared ? "Shared · \(name)" : name }

	var isDirect: Bool {
		if case .direct = route { return true }
		return false
	}

	/// Each brain has a cookie store of its own, apart from Safari's and the other brains'.
	var dataStoreID: UUID {
		let digest = Array(SHA256.hash(data: Data("p2mac:\(id)".utf8)))
		return UUID(uuid: (
			digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
			digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]
		))
	}
}

extension Brain.Route {
	/// The origin pages of this route live on; links elsewhere open in the default browser.
	func contains(_ url: URL) -> Bool {
		guard case .direct(let origin, _) = self else { return false }
		return url.scheme == origin.scheme && url.host == origin.host && (url.port ?? 80) == (origin.port ?? 80)
	}

	/// The URL of `path`, an address of the brain's UI, on the brain itself.
	func url(_ path: String) -> URL {
		guard case .direct(let origin, _) = self else { return URL(string: "about:blank")! }
		return URL(string: path, relativeTo: origin)?.absoluteURL ?? origin
	}
}
