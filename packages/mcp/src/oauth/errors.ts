export class OAuthError extends Error {
	readonly code: string;
	readonly errorUri: string | undefined;

	constructor(code: string, message: string, errorUri?: string) {
		super(message || code);
		this.name = "OAuthError";
		this.code = code;
		this.errorUri = errorUri;
	}
}

export class OAuthIssuerMismatchError extends Error {
	readonly expected: string;
	readonly received: string;

	constructor(expected: string, received: string) {
		super(`OAuth issuer mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`);
		this.name = "OAuthIssuerMismatchError";
		this.expected = expected;
		this.received = received;
	}
}

export class OAuthInsecureEndpointError extends Error {
	readonly endpoint: string;

	constructor(endpoint: string) {
		super(`Refusing to send OAuth credentials to non-HTTPS endpoint ${endpoint}`);
		this.name = "OAuthInsecureEndpointError";
		this.endpoint = endpoint;
	}
}

export class OAuthRegistrationError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`OAuth dynamic client registration failed with status ${status}: ${body}`);
		this.name = "OAuthRegistrationError";
		this.status = status;
		this.body = body;
	}
}

export class McpOAuthAuthorizationRequiredError extends Error {
	constructor() {
		super("MCP OAuth authorization requires user interaction");
		this.name = "McpOAuthAuthorizationRequiredError";
	}
}
