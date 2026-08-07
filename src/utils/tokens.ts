import jwt, { Secret, SignOptions } from "jsonwebtoken";
import crypto from "crypto";
import {
  JWT_SECRET,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  ADMIN_TOKEN_EXPIRES_IN,
} from "../config/envVariables.js";

/**
 * Single owner of every JWT this service issues or accepts.
 *
 * Two properties are enforced here and nowhere else, so they cannot drift:
 *
 *  1. Every token carries a `type` claim. Previously an access token and a
 *     refresh token were byte-identical (`jwt.sign({id}, SECRET)`), which meant
 *     a 30-day refresh token was silently accepted as a 2-day access token —
 *     the short access-token lifetime bought nothing.
 *
 *  2. Every token carries an `exp`. The admin token previously had none, so a
 *     single capture granted permanent access.
 *
 * LEGACY GRACE PERIOD
 * Tokens minted before this change have no `type` claim. Rejecting them would
 * sign every user out on deploy, so `verifyAccessToken` still accepts a
 * type-less token *as an access token only*. A type-less token is never
 * accepted where a refresh or admin token is required, so the grace period
 * cannot be used to escalate. Remove `allowLegacy` once the 30-day refresh
 * window has fully rotated (see REFRESH_TOKEN_EXPIRES_IN).
 */

export type TokenType = "access" | "refresh" | "admin";

export interface AccessTokenPayload {
  id: string;
  type?: "access";
}

export interface RefreshTokenPayload {
  id: string;
  type: "refresh";
  jti: string;
}

export interface AdminTokenPayload {
  role: "admin";
  type: "admin";
}

/** Hash used to persist refresh tokens. See userModel for why SHA-256. */
export const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

export const signAccessToken = (userId: string): string =>
  jwt.sign({ id: userId, type: "access" }, JWT_SECRET as Secret, {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
  } as SignOptions);

/** Returns the signed token plus the `jti` needed to persist and revoke it. */
export const signRefreshToken = (
  userId: string,
): { token: string; jti: string; expiresAt: Date } => {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id: userId, type: "refresh", jti },
    JWT_SECRET as Secret,
    { expiresIn: REFRESH_TOKEN_EXPIRES_IN } as SignOptions,
  );
  const decoded = jwt.decode(token) as { exp: number };
  return { token, jti, expiresAt: new Date(decoded.exp * 1000) };
};

/**
 * The admin token asserts a ROLE. It deliberately does not contain the admin
 * secret: a JWT payload is base64url, not encryption, so the previous
 * `jwt.sign(adminSecretKey, JWT_SECRET)` published the master key to anyone
 * holding the token. Authorisation is now "this token says admin, and we
 * signed it", which is the entire purpose of a signature.
 */
export const signAdminToken = (): string =>
  jwt.sign({ role: "admin", type: "admin" }, JWT_SECRET as Secret, {
    expiresIn: ADMIN_TOKEN_EXPIRES_IN,
  } as SignOptions);

class TokenError extends Error {
  constructor(
    message: string,
    public readonly expired: boolean = false,
  ) {
    super(message);
  }
}
export { TokenError };

const verify = (token: string): Record<string, unknown> => {
  try {
    return jwt.verify(token, JWT_SECRET as Secret) as Record<string, unknown>;
  } catch (error: unknown) {
    const name = (error as { name?: string })?.name;
    if (name === "TokenExpiredError") {
      throw new TokenError("Token expired", true);
    }
    throw new TokenError("Invalid token");
  }
};

/**
 * @param allowLegacy accept a token with no `type` claim (pre-fix tokens).
 *        Only ever true for access tokens.
 */
export const verifyAccessToken = (
  token: string,
  allowLegacy = true,
): AccessTokenPayload => {
  const payload = verify(token);
  const type = payload.type as string | undefined;

  if (type === undefined) {
    if (!allowLegacy) throw new TokenError("Invalid token type");
    // Legacy token — no type claim. Accept as access only.
  } else if (type !== "access") {
    throw new TokenError("Invalid token type");
  }

  if (typeof payload.id !== "string") {
    throw new TokenError("Invalid token payload");
  }
  return { id: payload.id, type: "access" };
};

export const verifyRefreshToken = (token: string): RefreshTokenPayload => {
  const payload = verify(token);
  if (payload.type !== "refresh") {
    // Includes legacy type-less tokens: a token that could be replayed as an
    // access token must not also be able to mint new ones.
    throw new TokenError("Invalid token type");
  }
  if (typeof payload.id !== "string" || typeof payload.jti !== "string") {
    throw new TokenError("Invalid token payload");
  }
  return { id: payload.id, type: "refresh", jti: payload.jti };
};

export const verifyAdminToken = (token: string): AdminTokenPayload => {
  const payload = verify(token);
  if (payload.type !== "admin" || payload.role !== "admin") {
    throw new TokenError("Invalid token type");
  }
  return { role: "admin", type: "admin" };
};

/** Maximum simultaneous signed-in devices per account. */
export const MAX_REFRESH_GRANTS = 10;
