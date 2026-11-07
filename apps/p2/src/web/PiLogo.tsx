export function PiLogo({ compact = false }: { compact?: boolean }) {
	return (
		<svg className={`pi-logo ${compact ? "compact" : ""}`} viewBox="0 0 800 800" role="img" aria-label="Pi">
			<title>Pi</title>
			<path fill="#3c00e0" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
			<path fill="#3c00e0" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
			<path fill="#3c00e0" d="M517.36 400H634.72V634.72H517.36Z" />
		</svg>
	);
}
