/** Owner sign-in: logout. Logic and contract in src/auth/handlers.ts. */
import { type AuthRequest, type AuthResponse } from "../../src/auth/http.ts";
import { logout } from "../../src/auth/handlers.ts";

export default async function handler(request: AuthRequest, response: AuthResponse) {
  logout(request, response);
}
