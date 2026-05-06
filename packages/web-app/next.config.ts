import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: true,
	typescript: {
		tsconfigPath: "tsconfig.next.json",
	},
	serverExternalPackages: [
		"@mariozechner/clipboard",
		"@mariozechner/pi-ai",
		"@mariozechner/pi-agent-core",
		"@mariozechner/pi-coding-agent",
		"@mariozechner/pi-tui",
	],
	turbopack: {
		resolveAlias: {
			"@mariozechner/pi-ai": "../ai/dist/index.js",
			"@mariozechner/pi-ai/oauth": "../ai/dist/oauth.js",
			"@mariozechner/pi-agent-core": "../agent/dist/index.js",
			"@mariozechner/pi-coding-agent": "../coding-agent/dist/index.js",
			"@mariozechner/pi-tui": "../tui/dist/index.js",
		},
	},
};

export default nextConfig;
