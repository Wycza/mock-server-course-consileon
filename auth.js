/**
 * Bearer-token and cookie authentication for the mock API.
 *
 * Nothing here is cryptography — the "token" is a random opaque string kept in
 * a Map. It exists so the exercises have a realistic chain: log in, capture the
 * token from the response, send it on the next request, and see 401 (not
 * authenticated) and 403 (authenticated but not allowed) as two different
 * failures.
 */

const { header, cookie } = require("./request-utils");

const TOKEN_TTL_SECONDS = 3600;

/** Fixed session cookie, so the cookie-based endpoints are deterministic. */
const SESSION_COOKIE = "sessionId";
const SESSION_ID = "sess-8f3c-ada";

const USERS = {
  ada: {
    password: "password123",
    profile: {
      id: 1,
      username: "ada",
      firstName: "Ada",
      lastName: "Lovelace",
      role: "admin",
    },
  },
  linus: {
    password: "password123",
    profile: {
      id: 2,
      username: "linus",
      firstName: "Linus",
      lastName: "Torvalds",
      role: "user",
    },
  },
};

/** token -> username */
const tokens = new Map();

function verifyCredentials(username, password) {
  const user = USERS[username];
  if (!user || user.password !== password) return null;
  return user.profile;
}

function issueToken(username) {
  const token = `tok_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  tokens.set(token, username);
  return token;
}

function revokeToken(token) {
  return tokens.delete(token);
}

/** Pull the token out of `Authorization: Bearer <token>` (scheme is case-insensitive). */
function bearerToken(request) {
  const value = header(request, "authorization");
  if (!value) return undefined;

  const match = /^bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : undefined;
}

/**
 * Resolve the caller from the Authorization header.
 *
 * @returns {{profile: object, token: string} | null}
 */
function authenticate(request) {
  const token = bearerToken(request);
  if (!token) return null;

  const username = tokens.get(token);
  if (!username) return null;

  return { profile: USERS[username].profile, token };
}

/** Resolve the caller from the session cookie instead of a header. */
function authenticateByCookie(request) {
  return cookie(request, SESSION_COOKIE) === SESSION_ID
    ? USERS.ada.profile
    : null;
}

const UNAUTHORIZED = {
  statusCode: 401,
  headers: { "WWW-Authenticate": ['Bearer realm="mock-api"'] },
  body: { json: { error: "Missing or invalid access token" } },
};

const FORBIDDEN = {
  statusCode: 403,
  body: { json: { error: "Requires role: admin" } },
};

module.exports = {
  USERS,
  SESSION_COOKIE,
  SESSION_ID,
  TOKEN_TTL_SECONDS,
  verifyCredentials,
  issueToken,
  revokeToken,
  bearerToken,
  authenticate,
  authenticateByCookie,
  UNAUTHORIZED,
  FORBIDDEN,
};
