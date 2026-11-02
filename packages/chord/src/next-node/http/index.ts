// Chord v2's HTTP component (`@earendil-works/chord/next/http`, slice 10 §2): a Web-standard `fetch` handler built
// from the routes, wraps and sockets plugins contribute to the registry `Http`, with the security baseline on by
// default, Chord's own Node listener, a Node upgrade adapter and the Node request conversion for apps that mount it.
// Node-only; `ws` is an optional peer dependency, imported only here.

export type { Connection, Provenance } from "./admission.ts";
export { type Authenticator, Authenticators } from "./authenticate.ts";
export { type CookieOptions, cookie, readCookie } from "./cookies.ts";
export { type FileResponseOptions, fileResponse } from "./file.ts";
export {
	createHttp,
	type HookName,
	type HttpComponent,
	type HttpError,
	HttpListener,
	type HttpOptions,
	type LinksOptions,
} from "./http.ts";
export { type ListenAddress, type NodeRequest, nodeRequest } from "./node.ts";
export { HttpFailure, type HttpRequest } from "./request.ts";
export type { HttpResponse } from "./response.ts";
export {
	Http,
	type HttpContribution,
	type HttpRelay,
	type HttpRoute,
	type HttpRouteOptions,
	type HttpSocket,
	type HttpWrap,
	type Router,
	type WebSocketHandle,
	type WrapPhase,
} from "./router.ts";
export type { LinkOptions } from "./upgrades.ts";
