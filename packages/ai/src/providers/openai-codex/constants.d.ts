/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend.
 */
export declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export declare const OPENAI_HEADERS: {
	readonly BETA: "OpenAI-Beta";
	readonly ACCOUNT_ID: "chatgpt-account-id";
	readonly ORIGINATOR: "originator";
	readonly SESSION_ID: "session_id";
	readonly CONVERSATION_ID: "conversation_id";
};
export declare const OPENAI_HEADER_VALUES: {
	readonly BETA_RESPONSES: "responses=experimental";
	readonly ORIGINATOR_CODEX: "mu";
};
export declare const URL_PATHS: {
	readonly RESPONSES: "/responses";
	readonly CODEX_RESPONSES: "/codex/responses";
};
export declare const JWT_CLAIM_PATH: "https://api.openai.com/auth";
//# sourceMappingURL=constants.d.ts.map
