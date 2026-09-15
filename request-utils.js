/**
 * Helpers for reading a MockServer request inside a `.callback()` handler.
 *
 * MockServer hands the callback a raw HttpRequest (see mockServer.d.ts), not an
 * Express-like object: there is no `req.query`, no `req.params` and the body may
 * arrive in one of several shapes depending on how MockServer typed it. These
 * helpers normalise all of that.
 */

const { header } = require("./multipart");

/**
 * Query string as a plain `name -> string[]` map.
 *
 * MockServer changed this shape between versions: older builds send an array of
 * `{name, values}`, newer ones send an object. Handle both so the mock does not
 * break on an `npm update`.
 */
function queryParams(request) {
  const raw = request.queryStringParameters;
  if (!raw) return {};

  if (Array.isArray(raw)) {
    const result = {};
    for (const entry of raw) {
      if (entry && entry.name) result[entry.name] = entry.values || [];
    }
    return result;
  }

  const result = {};
  for (const [name, value] of Object.entries(raw)) {
    result[name] = Array.isArray(value) ? value : [value];
  }
  return result;
}

/** First value of a query parameter, or `fallback` when it was not sent. */
function queryParam(request, name, fallback = undefined) {
  const values = queryParams(request)[name];
  return values && values.length > 0 ? values[0] : fallback;
}

/** Last path segment — the stand-in for `:id` that MockServer does not give us. */
function lastSegment(request) {
  const path = request.path || "";
  const segments = path.split("?")[0].split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

/**
 * Parse the request body as JSON.
 *
 * @returns {{ok: true, value: any} | {ok: false, reason: string}}
 */
function jsonBody(request) {
  const body = request.body;

  if (body === undefined || body === null) {
    return { ok: false, reason: "empty" };
  }

  // MockServer typed it as JSON already.
  if (typeof body === "object" && body.json !== undefined) {
    return { ok: true, value: body.json };
  }

  const text =
    typeof body === "string"
      ? body
      : typeof body.string === "string"
        ? body.string
        : Buffer.isBuffer(body)
          ? body.toString("utf8")
          : undefined;

  if (text === undefined) {
    // A plain object that is neither {json} nor {string} is already the body.
    if (typeof body === "object") return { ok: true, value: body };
    return { ok: false, reason: "empty" };
  }

  if (text.trim() === "") return { ok: false, reason: "empty" };

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: "malformed" };
  }
}

/** Read one cookie out of the `Cookie` request header. */
function cookie(request, name) {
  const raw = header(request, "cookie");
  if (!raw) return undefined;

  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) {
      return decodeURIComponent(pair.slice(index + 1).trim());
    }
  }
  return undefined;
}

/** Shorthand for a JSON response in the shape MockServer expects. */
function json(statusCode, value, headers) {
  const response = { statusCode, body: { json: value } };
  if (headers) response.headers = headers;
  return response;
}

module.exports = {
  header,
  queryParams,
  queryParam,
  lastSegment,
  jsonBody,
  cookie,
  json,
};
