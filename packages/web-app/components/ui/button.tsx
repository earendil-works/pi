import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground shadow-[0_14px_35px_rgba(17,24,39,0.18)] hover:-translate-y-0.5 hover:bg-primary/92",
				destructive: "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
				outline:
					"border border-border bg-background/45 text-foreground shadow-sm backdrop-blur-xl hover:-translate-y-0.5 hover:bg-secondary/70",
				secondary: "bg-secondary text-secondary-foreground shadow-sm hover:-translate-y-0.5 hover:bg-secondary/80",
				ghost: "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
				link: "text-accent underline-offset-4 hover:underline",
			},
			size: {
				default: "h-10 px-4 py-2",
				sm: "h-8 px-3 text-xs",
				lg: "h-12 px-6 text-base",
				icon: "size-10",
				"icon-sm": "size-8",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps): React.ReactElement {
	const Comp = asChild ? Slot : "button";
	return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { buttonVariants };
