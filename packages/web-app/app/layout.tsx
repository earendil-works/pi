import type { Metadata, Viewport } from "next";
import type * as React from "react";
import "./globals.css";

export const metadata: Metadata = {
	title: "pi web",
	description: "A graphical interface for the pi coding agent harness.",
};

export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	maximumScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>): React.ReactElement {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className="noise antialiased">{children}</body>
		</html>
	);
}
