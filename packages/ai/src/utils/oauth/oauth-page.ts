/**
 * Branding options for the OAuth callback success/error pages. Each
 * OAuth flow that runs a local callback server (openai-codex,
 * anthropic, github-copilot, etc.) accepts these so consumer apps
 * can swap the default Pi logo/title for their own brand.
 *
 * All fields are optional — absence falls back to the historical
 * Pi-branded behavior, preserving back-compat.
 */
export interface OAuthPageBranding {
	/**
	 * Inline SVG markup rendered at the top of the page (above the
	 * heading). Should be a complete `<svg>...</svg>` string sized
	 * around 64-128 pixels — the page CSS scales it to a 72×72 box.
	 * Absence falls back to the bundled Pi logo.
	 */
	logoSvg?: string;
	/**
	 * Application name appended to the document `<title>` so users
	 * see e.g. "Authentication successful — Claudio Pipe" instead
	 * of the generic default. Absence keeps the plain default.
	 */
	appName?: string;
}

const DEFAULT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"/><path fill="#fff" d="M517.36 400 H634.72 V634.72 H517.36 Z"/></svg>`;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: {
	title: string;
	heading: string;
	message: string;
	details?: string;
	branding?: OAuthPageBranding;
}): string {
	const appName = options.branding?.appName;
	const fullTitle = appName ? `${options.title} — ${appName}` : options.title;
	const title = escapeHtml(fullTitle);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;
	// `branding.logoSvg` is RAW SVG markup, intentionally NOT html-escaped
	// — it's a trusted SVG string the consumer app supplied. Same handling
	// the bundled DEFAULT_LOGO_SVG already gets.
	const logoSvg = options.branding?.logoSvg ?? DEFAULT_LOGO_SVG;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${logoSvg}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message: string, branding?: OAuthPageBranding): string {
	return renderPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
		...(branding ? { branding } : {}),
	});
}

export function oauthErrorHtml(message: string, details?: string, branding?: OAuthPageBranding): string {
	return renderPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		...(details !== undefined ? { details } : {}),
		...(branding ? { branding } : {}),
	});
}
