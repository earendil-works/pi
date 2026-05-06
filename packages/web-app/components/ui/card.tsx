import type * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return (
		<div className={cn("rounded-[1.35rem] border bg-card text-card-foreground shadow-sm", className)} {...props} />
	);
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return <div className={cn("flex flex-col gap-1.5 p-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
	return <h3 className={cn("font-semibold leading-none tracking-tight", className)} {...props} />;
}

export function CardDescription({
	className,
	...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
	return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return <div className={cn("p-5 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
	return <div className={cn("flex items-center p-5 pt-0", className)} {...props} />;
}
