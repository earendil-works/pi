/** Owner sign-in: callback. Logic and contract in src/auth/handlers.ts. */
import { type AuthRequest, type AuthResponse } from "../../src/auth/http.ts";
import { callback } from "../../src/auth/handlers.ts";
import { realFetch } from "../../src/auth/real-fetch.ts";

export default async function handler(request: AuthRequest, response: AuthResponse) {
  await callback(request, response, { env: process.env, fetch: realFetch });
}
