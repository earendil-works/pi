export const AZURE_OPENAI_AUTH_MODE_ENV = "AZURE_OPENAI_AUTH_MODE";
export const AZURE_OPENAI_ENTRA_ID_MODE = "entra-id";
export const AZURE_OPENAI_ENTRA_ID_MARKER = "<azure-entra-id>";

export function isAzureEntraIdAuth(apiKey: string | undefined): boolean {
	return apiKey === AZURE_OPENAI_ENTRA_ID_MARKER;
}
