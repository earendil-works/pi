// swift-tools-version: 6.0
// The p2 macOS app (spike): a menu bar agent that runs the local p2 server, and windows showing its web UI.
import PackageDescription

let package = Package(
	name: "P2Mac",
	platforms: [.macOS(.v14)],
	dependencies: [
		// Updates for packaged builds (scripts/package-app.sh). Pinned: it installs code on users' Macs.
		.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.1"),
	],
	targets: [
		.executableTarget(
			name: "P2Mac",
			dependencies: [.product(name: "Sparkle", package: "Sparkle")],
			path: "Sources/P2Mac",
			swiftSettings: [.swiftLanguageMode(.v5)],
			// Sparkle.framework goes into Contents/Frameworks (scripts/build-app.sh).
			linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
		)
	]
)
