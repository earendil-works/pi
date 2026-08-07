// MatwingsVenus backend configuration.
//
// The backend base URL is configurable via the MATVENUS_BACKEND_URL env var
// (default: the test environment). API paths are prefixed with API_PATH_PREFIX
// ("/api") to match the matwingsvenus-web contract.

/** Base URL of the MatwingsVenus backend (trailing slashes stripped). */
export const BACKEND_URL: string = (process.env.MATVENUS_BACKEND_URL ?? "https://test.matvenus.com/test").replace(
	/\/+$/,
	"",
);

/**
 * Path prefix appended to BACKEND_URL for all API calls. Matches the web app's
 * `/api` mount. If the deployment exposes the API directly under BACKEND_URL
 * (no `/api`), set this to "".
 */
export const API_PATH_PREFIX = "/api";

/** Refresh the access token when it is within this many ms of expiry. */
export const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** Preferred Accept-Language sent on API requests. */
export function acceptLanguage(): string {
	return process.env.LANG?.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** Build a fully-qualified API URL from a path like "/user/login". */
export function apiUrl(path: string): string {
	const p = path.startsWith("/") ? path : `/${path}`;
	return `${BACKEND_URL}${API_PATH_PREFIX}${p}`;
}
