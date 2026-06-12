type VertexEnv = Partial<
	Record<
		| "ANTHROPIC_VERTEX_PROJECT_ID"
		| "CLOUD_ML_REGION"
		| "GCLOUD_PROJECT"
		| "GOOGLE_CLOUD_LOCATION"
		| "GOOGLE_CLOUD_PROJECT",
		string | undefined
	>
>;

type ProjectOptions = { project?: string };
type LocationOptions = { location?: string };

export function resolveGoogleVertexProject(options?: ProjectOptions, env: VertexEnv = process.env): string | undefined {
	return options?.project || env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
}

export function resolveGoogleVertexLocation(
	options?: LocationOptions,
	env: VertexEnv = process.env,
): string | undefined {
	return options?.location || env.GOOGLE_CLOUD_LOCATION;
}

export function resolveAnthropicVertexProject(
	options?: ProjectOptions,
	env: VertexEnv = process.env,
): string | undefined {
	return options?.project || env.ANTHROPIC_VERTEX_PROJECT_ID || resolveGoogleVertexProject(undefined, env);
}

export function resolveAnthropicVertexLocation(
	options?: LocationOptions,
	env: VertexEnv = process.env,
): string | undefined {
	return options?.location || env.CLOUD_ML_REGION || resolveGoogleVertexLocation(undefined, env);
}
