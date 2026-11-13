// swift-tools-version: 6.0
// The p2 macOS app (spike): a menu bar agent that runs the local p2 server, and windows showing its web UI.
import PackageDescription

let package = Package(
	name: "P2Mac",
	platforms: [.macOS(.v14)],
	targets: [
		.executableTarget(
			name: "P2Mac",
			path: "Sources/P2Mac",
			swiftSettings: [.swiftLanguageMode(.v5)]
		)
	]
)
