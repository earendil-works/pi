// p2's plugin API, version 1, for server facets (`@p2/app/v1/server`): the server's locals and registries (routes,
// authenticators, workers), HTTP helpers and pages, and Chord's process lock.
export { processLock } from "@earendil-works/chord/workers";
export { PROXY_MARKER_HEADER, requestOrigin } from "../../hosts/principals.ts";
export * from "../../runtime/http.ts";
export { LOCAL_CHALLENGE_PATH, LOCAL_CLAIM_PATH, localOwnerProof } from "../../runtime/local-owner.ts";
export * from "../../runtime/page.ts";
export * from "../../runtime/server.ts";
