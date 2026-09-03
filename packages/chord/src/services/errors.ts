export const REMOTE_SERVICE_ERROR_CODES = [
	"service_not_allowed",
	"service_not_found",
	"service_mode_mismatch",
	"service_member_not_found",
	"service_member_mismatch",
	"service_instance_not_found",
	"service_stale_instance",
	"service_invalid_value",
] as const;

export type RemoteServiceErrorCode = (typeof REMOTE_SERVICE_ERROR_CODES)[number];

export function isRemoteServiceErrorCode(value: unknown): value is RemoteServiceErrorCode {
	return typeof value === "string" && REMOTE_SERVICE_ERROR_CODES.includes(value as RemoteServiceErrorCode);
}

export class RemoteServiceError extends Error {
	readonly code: RemoteServiceErrorCode;

	constructor(code: RemoteServiceErrorCode, message: string) {
		super(message);
		this.name = "RemoteServiceError";
		this.code = code;
	}
}
