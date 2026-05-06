import type * as React from "react";
import { AnimatedGridPattern } from "@/components/magicui/animated-grid-pattern";
import { PiConsole } from "@/components/pi/pi-console";

export default function Home(): React.ReactElement {
	return (
		<main className="relative min-h-screen overflow-hidden">
			<AnimatedGridPattern />
			<PiConsole />
		</main>
	);
}
