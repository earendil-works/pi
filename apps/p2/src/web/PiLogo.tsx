export function PiLogo({ compact = false }: { compact?: boolean }) {
	return (
		<svg className={`pi-logo ${compact ? "compact" : ""}`} viewBox="0 0 4 4" role="img" aria-label="Pi">
			<title>Pi</title>
			<rect className="pi-logo-coral" width="3" height="1" />
			<rect className="pi-logo-coral" x="2" y="1" width="1" height="1" />
			<rect className="pi-logo-blue" y="1" width="1" height="3" />
			<rect className="pi-logo-blue" x="1" y="2" width="1" height="1" />
			<rect className="pi-logo-yellow" x="3" y="2" width="1" height="2" />
		</svg>
	);
}
