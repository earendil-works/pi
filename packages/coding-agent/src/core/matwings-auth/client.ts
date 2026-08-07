import { acceptLanguage, apiUrl } from "./config.ts";

// ---- Types -----------------------------------------------------------------

export type BindingType = "phone" | "email" | "any";

export interface UserProfile {
	id: string | number;
	name: string;
	email?: string | null;
	phone?: string | null;
	account_type?: string;
	[key: string]: unknown;
}

export interface SignInResult {
	access_token: string;
	refresh_token: string;
	/** ISO-8601 expiry of the access token. */
	expires_at: string;
	token_type: string;
	user: UserProfile;
	binding_required?: boolean;
	binding_type?: BindingType | null;
}

export interface AccountOption {
	user_id: string | number;
	name: string;
	account_type?: string;
	org_name?: string;
	avatar?: string | null;
}

export interface AccountSelectionResult {
	requires_account_selection: true;
	selection_token: string;
	accounts: AccountOption[];
}

export type LoginResult = SignInResult | AccountSelectionResult;

/** Type guard: did login require multi-identity account selection? */
export function isAccountSelection(result: LoginResult): result is AccountSelectionResult {
	return (result as AccountSelectionResult).requires_account_selection === true;
}

export interface SystemFeature {
	force_phone_binding?: boolean;
	force_email_binding?: boolean;
	[key: string]: unknown;
}

export interface PublicKeyResult {
	public_key_pem: string;
	fingerprint?: string;
	algorithm?: string;
	encrypted_prefix?: string;
}

export interface SendCodeResult {
	success: boolean;
	message?: string;
	identifier_type?: string;
}

// ---- Error handling --------------------------------------------------------

/** An API error carrying the HTTP status and backend error_code, if any. */
export class ApiError extends Error {
	status: number;
	code: string | undefined;
	constructor(status: number, code: string | undefined, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

/**
 * Map a backend error (code/detail/status) to a friendly Chinese message.
 * Subset of matwingsvenus-web's auth-errors.ts.
 */
export function mapAuthError(code: string | undefined, detail: string | undefined, status: number): string {
	const c = (code ?? "").toUpperCase();
	const d = (detail ?? "").toLowerCase();
	if (status === 429 || c.includes("RATE") || d.includes("频繁")) return "操作过于频繁，请稍后再试";
	if (c.includes("INVALID_CREDENTIAL") || d.includes("账号或密码错误") || d.includes("密码错误"))
		return "账号或密码错误";
	if (c.includes("VERIFICATION_CODE") || d.includes("验证码")) return "验证码错误或已过期";
	if (c.includes("DUPLICATE_PHONE")) return "该手机号已被其他账号绑定";
	if (c.includes("DUPLICATE_EMAIL")) return "该邮箱已被其他账号绑定";
	if (status === 401) return "未授权或登录已过期，请重新登录";
	if (status >= 500) return "服务器错误，请稍后再试";
	return detail ?? `请求失败 (${status})`;
}

// ---- HTTP core -------------------------------------------------------------

type Json = Record<string, unknown>;

interface RequestOptions {
	method: "GET" | "POST";
	body?: Json;
	bearer?: string;
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Accept-Language": acceptLanguage(),
	};
	if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
	const res = await fetch(apiUrl(path), {
		method: options.method,
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	if (!res.ok) {
		let detail: string | undefined;
		let code: string | undefined;
		try {
			const body = (await res.json()) as {
				detail?: unknown;
				message?: string;
				error_code?: string;
				code?: string;
			};
			if (typeof body.message === "string") detail = body.message;
			else if (Array.isArray(body.detail))
				detail = body.detail.map((e: { msg?: string }) => e?.msg).filter(Boolean).join("; ");
			else if (typeof body.detail === "string") detail = body.detail;
			code = body.error_code ?? body.code;
		} catch {
			try {
				detail = await res.text();
			} catch {
				detail = undefined;
			}
		}
		throw new ApiError(res.status, code, mapAuthError(code, detail, res.status));
	}
	const text = await res.text();
	return (text ? (JSON.parse(text) as T) : ({} as T));
}

// ---- Endpoints -------------------------------------------------------------

/** Fetch the RSA public key used to encrypt passwords (public, no auth). */
export function fetchPublicKey(): Promise<PublicKeyResult> {
	return request<PublicKeyResult>("/auth/password-public-key", { method: "GET" });
}

/** Password login. `encryptedPassword` must be `enc:<base64>` from encryptPassword. */
export function loginPassword(identifier: string, encryptedPassword: string): Promise<LoginResult> {
	return request<LoginResult>("/user/login", {
		method: "POST",
		body: { identifier, password: encryptedPassword },
	});
}

/** Send a login verification code to the identifier. */
export function sendLoginCode(identifier: string): Promise<SendCodeResult> {
	return request<SendCodeResult>("/user/send-verification-code", {
		method: "POST",
		body: { identifier, purpose: "login" },
	});
}

/** Verification-code login. */
export function loginWithCode(identifier: string, code: string): Promise<LoginResult> {
	return request<LoginResult>("/user/login-with-code", { method: "POST", body: { identifier, code } });
}

/** Second step of multi-identity login: pick an account, receive a JWT. */
export function selectAccount(selectionToken: string, selectedUserId: string | number): Promise<SignInResult> {
	return request<SignInResult>("/user/login/select", {
		method: "POST",
		bearer: selectionToken,
		body: { selection_token: selectionToken, selected_user_id: selectedUserId },
	});
}

/** Fetch the current user profile (used to validate an access token). */
export function getProfile(accessToken: string): Promise<UserProfile> {
	return request<UserProfile>("/user/profile", { method: "GET", bearer: accessToken });
}

/** Refresh the access token using a refresh token. */
export function renewToken(refreshToken: string): Promise<SignInResult> {
	return request<SignInResult>("/user/renew", { method: "POST", body: { refresh_token: refreshToken } });
}

/** Best-effort logout; ignores network/auth errors. */
export async function signOut(accessToken: string): Promise<void> {
	try {
		await request("/user/sign-out", { method: "POST", bearer: accessToken });
	} catch {
		// best-effort
	}
}

/** Fetch auth/feature flags (force_phone_binding, force_email_binding, ...). */
export function getSystemFeature(): Promise<SystemFeature> {
	return request<SystemFeature>("/system/feature", { method: "GET" });
}

/** Send the verification code for the bind flow (purpose="bind"). */
export function sendBindCode(accessToken: string, identifier: string): Promise<SendCodeResult> {
	return request<SendCodeResult>("/user/send-bind-code", {
		method: "POST",
		bearer: accessToken,
		body: { identifier, purpose: "bind" },
	});
}

/** Confirm a phone/email binding. `encryptedCurrentPassword` is `enc:<base64>`. */
export function bindAccount(
	accessToken: string,
	identifier: string,
	code: string,
	encryptedCurrentPassword: string,
): Promise<UserProfile> {
	return request<UserProfile>("/user/bind", {
		method: "POST",
		bearer: accessToken,
		body: { identifier, code, current_password: encryptedCurrentPassword },
	});
}
