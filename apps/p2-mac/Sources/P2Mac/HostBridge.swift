// The page's side of the app as its host: `window.webkit.messageHandlers.piHost` in the page's own world, on every
// brain page (direct and remote). Its presence tells p2 at startup that the app owns the light/dark preference
// (Appearance.swift), and p2's theme switch then asks the app instead of storing a value of its own:
//
//   page → app  { type: "theme" }                        reply { preference }
//   page → app  { type: "set-theme", preference }        stores, applies, reply { preference }
//   app → page  CustomEvent "pi-host-theme", detail { preference }   after every change, to all pages of all windows
//
// The resolved scheme is never sent: the page reads it from `matchMedia`, which follows the app's appearance. WebKit
// exposes the handler to every frame of the page, not only the main one: it is answered for the main frame of a page
// on the brain's own origin only, and refuses everything else. The worst a page can do is change the appearance.
import WebKit

@MainActor
enum HostBridge {
	static let handler = "piHost"

	/// Installs the handler for `page`'s webview in `controller`.
	static func install(in controller: WKUserContentController, for page: BrainPage) {
		controller.addScriptMessageHandler(Receiver(page), contentWorld: .page, name: handler)
	}

	/// Tells the page in `webView` that the preference is now `preference`.
	static func themeChanged(_ preference: Appearance, in webView: WKWebView) {
		webView.callAsyncJavaScript(
			#"window.dispatchEvent(new CustomEvent("pi-host-theme", { detail: { preference } }))"#,
			arguments: ["preference": preference.rawValue], in: nil, in: .page)
	}

	/// Holds the page weakly for WebKit, which retains its message handlers.
	private final class Receiver: NSObject, WKScriptMessageHandlerWithReply {
		weak var page: BrainPage?

		init(_ page: BrainPage) { self.page = page }

		func userContentController(
			_ controller: WKUserContentController, didReceive message: WKScriptMessage,
			replyHandler: @escaping (Any?, String?) -> Void
		) {
			// Trust boundary: the message is page input. Frames inside the page (artifact previews) and pages on other
			// origins get nothing.
			guard let page, message.frameInfo.isMainFrame, page.owns(message.frameInfo.securityOrigin) else {
				return replyHandler(nil, "piHost: not allowed here")
			}
			let body = message.body as? [String: Any]
			switch body?["type"] as? String {
			case "theme":
				replyHandler(["preference": page.app.appearance.rawValue], nil)
			case "set-theme":
				guard let next = (body?["preference"] as? String).flatMap(Appearance.init) else {
					return replyHandler(nil, "piHost: invalid preference")
				}
				page.app.setAppearance(next)
				replyHandler(["preference": page.app.appearance.rawValue], nil)
			default:
				replyHandler(nil, "piHost: unknown message")
			}
		}
	}
}
