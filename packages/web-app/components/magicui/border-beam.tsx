import type * as React from "react";
import { cn } from "@/lib/utils";

export function BorderBeam({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-0 rounded-[inherit] [mask:linear-gradient(#fff_0_0)_content-box,linear-gradient(#fff_0_0)] [mask-composite:exclude] p-px",
				className,
			)}
			{...props}
		>
			<div className="absolute aspect-square w-32 rounded-full bg-[conic-gradient(from_0deg,transparent_0_30%,rgba(59,130,246,0.75),rgba(180,83,9,0.7),transparent_70%)] [animation:border-orbit_7s_linear_infinite]" />
		</div>
	);
}
