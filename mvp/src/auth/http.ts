/** Minimal request/response shapes for the sign-in handlers, so they can be tested without a server. */
export interface AuthRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

export interface AuthResponse {
  setHeader(name: string, value: string | string[]): unknown;
  status(code: number): { json(body: unknown): unknown; end(): unknown };
}

/** First value of a query parameter. */
export function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
