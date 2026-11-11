// A brain the app shows: one p2 server at one origin. The spike knows only this Mac's; Radius brains come later.
import CryptoKit
import Foundation

struct Brain: Equatable {
	/// Stable ID: the window tab group, the frame autosave name and the cookie store derive from it.
	let id: String
	let title: String
	let origin: URL

	/// This Mac's brain, reached directly on loopback.
	static func local(_ config: ServerConfig) -> Brain {
		Brain(id: "local-\(config.port)", title: "Pi on this Mac", origin: config.origin)
	}

	/// Each brain has a cookie store of its own, apart from Safari's and the other brains'.
	var dataStoreID: UUID {
		let digest = Array(SHA256.hash(data: Data("p2mac:\(id)".utf8)))
		return UUID(uuid: (
			digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
			digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]
		))
	}

	/// Whether `url` belongs to this brain's origin, so it opens in the app rather than in the browser.
	func contains(_ url: URL) -> Bool {
		url.scheme == origin.scheme && url.host == origin.host && (url.port ?? 80) == (origin.port ?? 80)
	}

	/// The absolute URL of a path on this brain.
	func url(_ path: String) -> URL {
		URL(string: path, relativeTo: origin)?.absoluteURL ?? origin
	}
}
