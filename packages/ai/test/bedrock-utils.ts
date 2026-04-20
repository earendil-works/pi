/**
 * Utility functions for Amazon Bedrock tests
 */

/**
 * Check if any valid AWS credentials are configured for Bedrock.
 * Returns true if any of the following are set:
 * - AWS_PROFILE (named profile from ~/.aws/credentials)
 * - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (IAM keys)
 * - AWS_BEARER_TOKEN_BEDROCK (Bedrock API key)
 * - AWS_BEARER_TOKEN_BEDROCK_CMD (command that returns a fresh bearer token)
 */
export function hasBedrockCredentials(): boolean {
	return !!(
		process.env.AWS_PROFILE ||
		(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
		process.env.AWS_BEARER_TOKEN_BEDROCK ||
		process.env.AWS_BEARER_TOKEN_BEDROCK_CMD
	);
}
