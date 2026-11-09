/**
 * Input modalities a model can accept, shared by the model schema and the catalog generator.
 *
 * Kept apart from `providers/model-schema.ts` so the generator can name them without loading the
 * schema builder package, which a bare checkout or a temporary copy does not resolve.
 */

export const MODEL_INPUT_MODALITIES = ["text", "image", "audio", "video"] as const;

export type ModelInputModality = (typeof MODEL_INPUT_MODALITIES)[number];
