/** Owner sign-in: login. Logic and contract in src/auth/handlers.ts. */
import { type AuthRequest, type AuthResponse } from "../../src/auth/http.ts";
import { login } from "../../src/auth/handlers.ts";
import { realFetch } from "../../src/auth/real-fetch.ts";

export default async function handler(request: AuthRequest, response: AuthResponse) {
  login(request, response, { env: process.env, fetch: realFetch });
}
