import { local } from "@p2/app/v1";

export { PROXY_MARKER_HEADER } from "@p2/app/v1/server";

export const ProxyMarker = local("p2.proxy-marker", { version: 1, params: {}, members: {} });
