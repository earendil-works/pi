// The whole sandbox Worker: one Durable Object class that runs codemode scripts for callers bound to
// it. Only Workers with a binding can reach the class; HTTP requests get a 404.
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

export default {
	fetch: () => new Response("Not found", { status: 404 }),
};
