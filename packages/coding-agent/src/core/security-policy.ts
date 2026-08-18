/**
 * Security policy for closed-network deployments.
 *
 * When secureMode is enabled (via settings.json "secureMode": true), only providers
 * that have an explicit baseUrl configured in models.json are permitted to make LLM
 * API calls. Built-in providers that would otherwise reach commercial cloud endpoints
 * are blocked unless the user has redirected them to internal infrastructure.
 */

export const SECURE_MODE_PROVIDER_ERROR =
	"secureMode is enabled. Provider requires an explicit baseUrl in models.json pointing to internal infrastructure.";
