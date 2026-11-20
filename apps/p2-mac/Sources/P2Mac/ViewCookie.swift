// The view cookie of a remote Pi's forwarded origin (`https://<label>.rdtun.com`), renewed while its page is open.
//
// A grant leaves a view cookie that lasts 12 hours (Radius's CORTEX_VIEW_TTL_SECONDS), but a Pi's page stays open for
// days. Its live connection outlasts the cookie, so the page keeps working, but every request it makes after that (a
// chat image, a file, an artifact) gets the origin's 401 page. A navigation would recover (the origin sends it to
// `/pi/forward`, and BrainPage gets a new grant), but those requests are no navigations. So BrainPage renews the cookie
// every half lifetime with a fresh grant from Radius, which checks the user's access each time; the origin never
// extends a cookie on its own. The page itself never reloads.
import Foundation

enum ViewCookie {
	/// Half the cookie's lifetime: a renewal that fails has hours of retries before the cookie ends.
	static let renewEvery: Duration = .seconds(6 * 60 * 60)
	/// After a failed renewal (Radius or the network unreachable), the next try.
	static let retryAfter: Duration = .seconds(5 * 60)

	enum Failure: Error, LocalizedError {
		case refused(Int)

		var errorDescription: String? {
			switch self {
			case .refused(let status): "The Pi's origin set no view cookie (\(status))"
			}
		}
	}

	/// The view cookie the origin sets for `grant` (a grant URL from `RadiusAccount.openURL`), for its page in a tab.
	/// The grant goes without its path: the origin then answers with the cookie and 204 instead of redirecting to a page.
	static func exchange(_ grant: URL) async throws -> HTTPCookie {
		var components = URLComponents(url: grant, resolvingAgainstBaseURL: false)!
		components.queryItems = components.queryItems?.filter { $0.name != "path" }
		var request = URLRequest(url: components.url!)
		// As the page's own load: the origin gives a tab its `SameSite=Lax` cookie, a frame a partitioned one.
		request.setValue("navigate", forHTTPHeaderField: "Sec-Fetch-Mode")
		request.setValue("document", forHTTPHeaderField: "Sec-Fetch-Dest")
		request.setValue("none", forHTTPHeaderField: "Sec-Fetch-Site")
		let (_, response) = try await session.data(for: request)
		let answer = response as! HTTPURLResponse
		let headers = answer.allHeaderFields.reduce(into: [String: String]()) { result, field in
			if let name = field.key as? String, let value = field.value as? String { result[name] = value }
		}
		guard answer.statusCode == 204, let cookie = HTTPCookie.cookies(withResponseHeaderFields: headers, for: grant).first
		else { throw Failure.refused(answer.statusCode) }
		return cookie
	}

	// Cookies are taken from the answer by hand: they belong in the page's store, not in a shared one.
	private static let session: URLSession = {
		let configuration = URLSessionConfiguration.ephemeral
		configuration.httpShouldSetCookies = false
		configuration.httpCookieAcceptPolicy = .never
		configuration.timeoutIntervalForRequest = 15
		return URLSession(configuration: configuration)
	}()
}
