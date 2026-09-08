/**
 * Minimal multipart/form-data parser for MockServer callbacks.
 *
 * MockServer does NOT parse multipart bodies — a callback receives the raw
 * request (see HttpRequest in mockserver-client/mockServer.d.ts), so there is
 * no `request.files` map. This turns `request.body` back into bytes and picks
 * the named part out by hand.
 */

/** Case-insensitive header lookup; MockServer headers are name -> [values]. */
function header(request, name) {
  const headers = request.headers || {};
  const wanted = name.toLowerCase();

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * Recover the request body as a Buffer. MockServer serialises a body it cannot
 * type as {type:"BINARY", base64Bytes}, but a recognised text type arrives as a
 * plain string or {type:"STRING", string}, so handle every shape.
 */
function rawBody(request) {
  const body = request.body;

  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  // latin1, not utf8: it maps bytes 1:1, so a body MockServer decoded as
  // ISO-8859-1 round-trips instead of being mangled into replacement chars.
  if (typeof body === "string") return Buffer.from(body, "latin1");

  if (typeof body.base64Bytes === "string") {
    return Buffer.from(body.base64Bytes, "base64");
  }
  if (typeof body.rawBytes === "string") {
    return Buffer.from(body.rawBytes, "base64");
  }
  if (typeof body.string === "string") {
    return Buffer.from(body.string, "latin1");
  }
  return Buffer.alloc(0);
}

/** Pull `boundary=...` out of the Content-Type header (may be quoted). */
function boundaryOf(request) {
  const contentType = header(request, "content-type") || "";
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? match[1] || match[2] : undefined;
}

/** Split a part's `name="x"; filename="y"` disposition into a map. */
function disposition(rawHeaders) {
  const line = rawHeaders
    .split("\r\n")
    .find((h) => /^content-disposition\s*:/i.test(h));
  if (!line) return {};

  const result = {};
  for (const [, key, quoted, bare] of line.matchAll(
    /;\s*([\w*-]+)=(?:"([^"]*)"|([^";]*))/g,
  )) {
    result[key.toLowerCase()] = (quoted !== undefined ? quoted : bare).trim();
  }
  return result;
}

function contentTypeOf(rawHeaders) {
  const line = rawHeaders
    .split("\r\n")
    .find((h) => /^content-type\s*:/i.test(h));
  return line ? line.slice(line.indexOf(":") + 1).trim() : undefined;
}

/**
 * Parse a multipart/form-data request into its parts.
 *
 * @returns {Array<{name?: string, filename?: string, contentType?: string, content: Buffer}>}
 */
function parseMultipart(request) {
  const boundary = boundaryOf(request);
  if (!boundary) return [];

  // Every boundary in the body is preceded by CRLF, including the first one
  // once we prepend it here; that makes a single delimiter split correct.
  const body = Buffer.concat([Buffer.from("\r\n"), rawBody(request)]);
  const delimiter = Buffer.from(`\r\n--${boundary}`);

  const parts = [];
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) return parts;

  while (cursor !== -1) {
    let start = cursor + delimiter.length;

    // "--" right after the boundary is the closing delimiter.
    if (body.slice(start, start + 2).toString("latin1") === "--") break;

    const next = body.indexOf(delimiter, start);
    if (next === -1) break;

    // Skip the CRLF (or any transport padding) that ends the boundary line.
    const lineEnd = body.indexOf("\r\n", start);
    if (lineEnd === -1 || lineEnd >= next) break;
    start = lineEnd + 2;

    const headerEnd = body.indexOf("\r\n\r\n", start);
    const hasHeaders = headerEnd !== -1 && headerEnd < next;
    const rawHeaders = hasHeaders
      ? body.slice(start, headerEnd).toString("latin1")
      : "";
    const contentStart = hasHeaders ? headerEnd + 4 : start;

    const attributes = disposition(rawHeaders);
    parts.push({
      name: attributes.name,
      filename: attributes.filename,
      contentType: contentTypeOf(rawHeaders),
      content: body.slice(contentStart, next),
    });

    cursor = next;
  }

  return parts;
}

/**
 * Find one uploaded file part by form field name — the `request.files["file"]`
 * that MockServer does not give you.
 *
 * @returns {{name?: string, filename?: string, contentType?: string, content: Buffer} | null}
 */
function extractFilePart(request, fieldName) {
  const parts = parseMultipart(request);
  return parts.find((part) => part.name === fieldName) || null;
}

module.exports = { parseMultipart, extractFilePart, rawBody, header };
