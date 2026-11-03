/**
 * The `mcpServers` configuration shape that MCP clients share, so configurations can be copied between
 * them: stdio servers (`command`, `args`, `env`, `cwd`), Streamable HTTP servers (`url`, `headers`,
 * `oauth`), and `enabled`, `description` and `timeout` for both.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
 *   }
 * }
 * ```
 *
 * Applications add fields of their own: {@link validateMcpServerConfig} keeps fields it does not know
 * for the caller to check afterwards.
 */

/** Fields every server entry may have. */
interface McpServerConfigBase {
	/** What the server offers, in a sentence. */
	description?: string;
	/** Set to false to keep the entry without connecting. Default: true. */
	enabled?: boolean;
	/** Per-request timeout in seconds. */
	timeout?: number;
}

/** A server started as a local program that speaks MCP over stdin and stdout. */
export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	/** Added to the environment. The application decides whether values may reference variables (`${NAME}`). */
	env?: Record<string, string>;
	/** The application decides what relative paths resolve against. */
	cwd?: string;
}

/** OAuth client settings for servers that do not support dynamic client registration. */
export interface McpOAuthConfig {
	/** Pre-registered client id. Without it, the application registers a client with the authorization server. */
	clientId?: string;
	/** As configured; the application decides whether it may reference variables. */
	clientSecret?: string;
	/**
	 * Port of the loopback callback server, for clients registered with a fixed redirect URI. Without
	 * `callbackUrl`, the redirect URI is `http://127.0.0.1:<port>/callback`.
	 */
	callbackPort?: number;
	/**
	 * Redirect URI registered for `clientId`, for example `http://localhost:8080/oauth/callback`. It must
	 * be an `http` URI on `localhost`, `127.0.0.1`, or `[::1]`. Without a port, the callback server
	 * listens on `callbackPort` or a free port, which is added to the URI (RFC 8252).
	 */
	callbackUrl?: string;
	/** Scopes to request, separated by spaces. Default: the scopes the server advertises. */
	scope?: string;
	/** `client_name` sent with dynamic client registration. Default: the application's name. */
	clientName?: string;
	/**
	 * How the application identifies itself without `clientId`. `auto` (default): its Client ID Metadata
	 * Document when the authorization server supports them for public clients, otherwise dynamic client
	 * registration. `cimd`: always the document, and sign-in fails without support. `dcr`: always
	 * dynamic client registration.
	 */
	clientRegistration?: "auto" | "dcr" | "cimd";
	/**
	 * Authorization server metadata document (RFC 8414 or OpenID Connect discovery) to use instead of
	 * discovery through the server, for servers that advertise a wrong authorization server or none.
	 * The document is trusted as configured. Must use https, except on loopback hosts.
	 */
	authServerMetadataUrl?: string;
}

/** A server reached over Streamable HTTP. */
export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	/** Sent with every request. The application decides whether values may reference variables. */
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig;
}

/** One entry of the `mcpServers` shape: a stdio or a Streamable HTTP server. */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/**
 * A validated server entry, tagged with its transport, or why it is invalid. The config is the entry
 * as given: fields the validator does not know are kept, unchecked, for the caller to check.
 */
export type McpServerConfigResult =
	| { kind: "stdio"; config: McpStdioServerConfig & Record<string, unknown> }
	| { kind: "http"; config: McpHttpServerConfig & Record<string, unknown> }
	| { kind: "invalid"; error: string };

/** What the application adds to the validation of server entries. */
export interface McpServerConfigOptions {
	/**
	 * Checks the `oauth.callbackUrl` (undefined: none configured) of an entry with
	 * `oauth.clientRegistration: "cimd"`: the application's Client ID Metadata Documents must list it.
	 * Returns an error message. Without this check, `"cimd"` is refused.
	 */
	checkMetadataDocumentCallback?(callbackUrl: string | undefined): string | undefined;
}

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Validate one entry of the `mcpServers` shape (configuration files are a trust boundary). Server
 * names are letters, digits, `_` and `-`, which tool names and namespaces are built from.
 */
export function validateMcpServerConfig(
	name: string,
	raw: unknown,
	options: McpServerConfigOptions = {},
): McpServerConfigResult {
	const invalid = (error: string): McpServerConfigResult => ({ kind: "invalid", error });
	if (!SERVER_NAME.test(name)) return invalid(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
	if (!isRecord(raw)) return invalid(`server "${name}" must be an object`);
	const fieldsError = validateBaseFields(raw);
	if (fieldsError) return invalid(`server "${name}": ${fieldsError}`);
	const { type, url, command } = raw;
	if (type === "sse") {
		return invalid(`server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`);
	}
	// The casts below hold because the fields were checked one by one, which the types cannot express.
	if (typeof url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		const error = validateHttpFields(raw, url, options);
		if (error) return invalid(`server "${name}": ${error}`);
		return { kind: "http", config: raw as McpHttpServerConfig & Record<string, unknown> };
	}
	if (typeof command === "string" && (type === undefined || type === "stdio")) {
		const error = validateStdioFields(raw);
		if (error) return invalid(`server "${name}": ${error}`);
		return { kind: "stdio", config: raw as McpStdioServerConfig & Record<string, unknown> };
	}
	return invalid(`server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBaseFields(entry: Record<string, unknown>): string | undefined {
	const { enabled, timeout, description } = entry;
	if (enabled !== undefined && typeof enabled !== "boolean") return "enabled must be a boolean";
	if (description !== undefined && typeof description !== "string") return "description must be a string";
	if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) {
		return "timeout must be a positive number of seconds";
	}
	return undefined;
}

function validateHttpFields(
	entry: Record<string, unknown>,
	url: string,
	options: McpServerConfigOptions,
): string | undefined {
	if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return "url must be an http or https URL";
	if (entry.headers !== undefined && !isStringRecord(entry.headers)) return "headers must map names to strings";
	return validateOAuth(entry.oauth, options);
}

function validateStdioFields(entry: Record<string, unknown>): string | undefined {
	const { args, env, cwd } = entry;
	if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === "string"))) {
		return "args must be an array of strings";
	}
	if (env !== undefined && !isStringRecord(env)) return "env must map names to strings";
	if (cwd !== undefined && typeof cwd !== "string") return "cwd must be a string";
	return undefined;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function validateOAuth(value: unknown, options: McpServerConfigOptions): string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return "oauth must be an object";
	if (value.clientId !== undefined && typeof value.clientId !== "string") return "oauth.clientId must be a string";
	if (value.clientSecret !== undefined && typeof value.clientSecret !== "string") {
		return "oauth.clientSecret must be a string";
	}
	const port = value.callbackPort;
	if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
		return "oauth.callbackPort must be a port number";
	}
	if (value.callbackUrl !== undefined) {
		if (typeof value.callbackUrl !== "string" || !isLoopbackRedirectUri(value.callbackUrl)) {
			return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
		}
		const urlPort = new URL(value.callbackUrl).port;
		if (urlPort && port !== undefined && Number(urlPort) !== port) {
			return "oauth.callbackUrl and oauth.callbackPort name different ports";
		}
	}
	if (value.scope !== undefined && typeof value.scope !== "string") return "oauth.scope must be a string";
	if (value.clientName !== undefined && (typeof value.clientName !== "string" || !value.clientName.trim())) {
		return "oauth.clientName must be a non-empty string";
	}
	const registration = value.clientRegistration;
	if (registration !== undefined && registration !== "auto" && registration !== "dcr") {
		if (registration !== "cimd") return 'oauth.clientRegistration must be "auto", "dcr", or "cimd"';
		if (value.clientId !== undefined || value.clientName !== undefined) {
			return 'oauth.clientRegistration "cimd" cannot be combined with oauth.clientId or oauth.clientName';
		}
		if (!options.checkMetadataDocumentCallback) {
			return 'oauth.clientRegistration "cimd" is not supported: there are no Client ID Metadata Documents';
		}
		const callbackError = options.checkMetadataDocumentCallback(
			typeof value.callbackUrl === "string" ? value.callbackUrl : undefined,
		);
		if (callbackError) return callbackError;
	}
	const metadataUrl = value.authServerMetadataUrl;
	if (metadataUrl !== undefined) {
		const url = typeof metadataUrl === "string" && URL.canParse(metadataUrl) ? new URL(metadataUrl) : undefined;
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)))) {
			return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
		}
	}
	return undefined;
}

/** Whether a redirect URI can be served by a loopback callback server. */
function isLoopbackRedirectUri(value: string): boolean {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname) && url.search === "" && url.hash === "";
}

/**
 * Whether an entry overrides a server defined elsewhere instead of defining one: it has no `command`,
 * `url` or `type`. Applications let a less trusted file (a project's) override a few fields, such as
 * `enabled`, of a server a trusted file defines; which fields is theirs to decide.
 */
export function isMcpServerOverride(entry: Record<string, unknown>): boolean {
	return entry.command === undefined && entry.url === undefined && entry.type === undefined;
}
