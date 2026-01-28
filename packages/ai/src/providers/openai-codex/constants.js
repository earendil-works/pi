/**
 * Constants for OpenAI Codex (ChatGPT OAuth) backend.
 */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
};
export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	ORIGINATOR_CODEX: "mu",
};
export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
};
export const JWT_CLAIM_PATH = "https://api.openai.com/auth";
//# sourceMappingURL=constants.js.map
