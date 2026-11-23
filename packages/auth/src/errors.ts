export type AuthErrorCode =
  | "invalid_credentials"
  | "locked"
  | "forbidden"
  | "not_found"
  | "expired"
  | "invalid_request"
  | "conflict"
  | "unauthenticated"
  | "signature_outdated"
  | "origin_mismatch";

const STATUS: Record<AuthErrorCode, number> = {
  invalid_credentials: 401,
  signature_outdated: 401,
  origin_mismatch: 401,
  unauthenticated: 401,
  expired: 401,
  locked: 429,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
};

/**
 * Error with an HTTP status and a message for the user (Italian, no internal detail).
 * Login failures always use the same message, so they do not reveal whether a user exists.
 */
export class AuthError extends Error {
  readonly status: number;
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AuthError";
    this.status = STATUS[code];
  }
}

export const LOGIN_FAILED = "Accesso non riuscito: controlla nome utente e codice.";
