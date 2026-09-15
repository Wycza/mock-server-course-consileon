const mockServer = require("mockserver-node");
const { mockServerClient } = require("mockserver-client");
const { extractFilePart } = require("./multipart");
const { validateCsv } = require("./csv");
const { queryParams, lastSegment, jsonBody, json } = require("./request-utils");
const auth = require("./auth");
const store = require("./products");

const HOST = "localhost";
const PORT = 1080;

// Match for as long as the server runs. MockServer's default is
// remainingTimes: 1 — the endpoint answers once and then 404s, which makes
// re-running a Bruno request look broken for no visible reason.
const ALWAYS = { unlimited: true };

// Counter behind GET /api/rate-limited; POST /api/reset puts it back to zero.
const RATE_LIMIT = 3;
let rateLimitHits = 0;

/* -------------------------------------------------------------------------- */
/* Endpoints from the first session — kept so older Bruno collections still run */
/* -------------------------------------------------------------------------- */

async function registerLegacyExpectations(client) {
  // http://localhost:1080/helloWorld
  await client
    .when({
      method: "GET",
      path: "/helloWorld",
    })
    .withTimes(ALWAYS)
    .respond({
      statusCode: 200,
      body: { json: { message: "Hello World" } },
    });

  // http://localhost:1080/login
  await client
    .when({
      method: "POST",
      path: "/login",
      // JSON body matcher: key order does not matter and extra fields are
      // allowed (the default is ONLY_MATCHING_FIELDS, not strict matching).
      // The caller MUST send Content-Type: application/json or this won't match.
      body: { username: "foo", password: "bar" },
    })
    .withTimes(ALWAYS)
    .respond({
      statusCode: 200,
      body: { json: { firstName: "Mateusz", lastName: "Wyczawski" } },
    });

  // http://localhost:1080/validate-file
  // Local callback, NOT .respond(): .respond() only accepts a plain response
  // object (a function is silently dropped by JSON.stringify), while .callback()
  // is the chain terminal that runs the handler in this Node process.
  // The handler MUST be synchronous — mockWithCallback does
  // `var response = requestHandler(request)` and stringifies it immediately,
  // so an async handler would serialise as an empty {}.
  await client
    .when({
      method: "POST",
      path: "/validate-file",
    })
    .withTimes(ALWAYS)
    .callback((request) => {
      // MockServer does not parse multipart bodies — there is no request.files.
      const part = extractFilePart(request, "file");

      if (!part) {
        return json(400, { error: "CSV file is required", details: [] });
      }

      const result = validateCsv(part.content);

      if (!result.valid) {
        return json(400, {
          error: "CSV validation failed",
          filename: part.filename,
          details: result.errors,
        });
      }

      return json(200, {
        success: true,
        filename: part.filename,
        rowCount: result.rowCount,
        rows: result.rows,
      });
    });
}

/* -------------------------------------------------------------------------- */
/* Authentication: bearer tokens, roles, and a cookie-based variant            */
/* -------------------------------------------------------------------------- */

async function registerAuthExpectations(client) {
  // POST /auth/token — exchange credentials for a bearer token.
  // Unlike /login this answers 401 on bad credentials instead of letting the
  // request fall through to MockServer's "no expectation matched" 404.
  await client
    .when({ method: "POST", path: "/auth/token" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const body = jsonBody(request);
      if (!body.ok) {
        return json(400, { error: `Request body is ${body.reason} JSON` });
      }

      const { username, password } = body.value || {};
      const profile = auth.verifyCredentials(username, password);

      if (!profile) {
        return json(401, { error: "Invalid credentials" });
      }

      return json(200, {
        tokenType: "Bearer",
        accessToken: auth.issueToken(username),
        expiresIn: auth.TOKEN_TTL_SECONDS,
        role: profile.role,
      });
    });

  // GET /me — the token from /auth/token has to come back as a header.
  await client
    .when({ method: "GET", path: "/me" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const session = auth.authenticate(request);
      if (!session) return auth.UNAUTHORIZED;
      return json(200, session.profile);
    });

  // POST /auth/logout — the token stops working afterwards.
  await client
    .when({ method: "POST", path: "/auth/logout" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const session = auth.authenticate(request);
      if (!session) return auth.UNAUTHORIZED;

      auth.revokeToken(session.token);
      return { statusCode: 204 };
    });

  // POST /auth/login-cookie — same idea, but the credential travels in a cookie
  // that the HTTP client stores and replays on its own.
  await client
    .when({
      method: "POST",
      path: "/auth/login-cookie",
      body: { username: "ada", password: "password123" },
    })
    .withTimes(ALWAYS)
    .respond({
      statusCode: 200,
      cookies: { [auth.SESSION_COOKIE]: auth.SESSION_ID },
      body: { json: { message: "Logged in", username: "ada" } },
    });

  // GET /auth/whoami — reads the cookie the browser/Bruno cookie jar replays.
  await client
    .when({ method: "GET", path: "/auth/whoami" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const profile = auth.authenticateByCookie(request);
      if (!profile) {
        return json(401, { error: "Missing or invalid session cookie" });
      }
      return json(200, profile);
    });
}

/* -------------------------------------------------------------------------- */
/* Products: a stateful CRUD resource                                          */
/* -------------------------------------------------------------------------- */

/** Resolve `/api/products/:id` into a number, or an error response. */
function productIdFrom(request) {
  const raw = lastSegment(request);
  const id = store.toInteger(raw);

  if (!Number.isInteger(id)) {
    return { error: json(400, { error: `Product id must be a number, got "${raw}"` }) };
  }
  return { id };
}

/** Every write endpoint needs a token first; DELETE additionally needs admin. */
function requireAuth(request, { role } = {}) {
  const session = auth.authenticate(request);
  if (!session) return { error: auth.UNAUTHORIZED };
  if (role && session.profile.role !== role) return { error: auth.FORBIDDEN };
  return { profile: session.profile };
}

async function registerProductExpectations(client) {
  // GET /api/products?category=&inStock=&sort=&page=&pageSize=
  await client
    .when({ method: "GET", path: "/api/products" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const query = queryParams(request);
      const flat = Object.fromEntries(
        Object.entries(query).map(([name, values]) => [name, values[0]]),
      );

      const { errors, options } = store.parseListQuery(flat);
      if (errors.length > 0) {
        return json(400, { error: "Invalid query parameter", details: errors });
      }

      return json(200, store.listProducts(options));
    });

  // POST /api/products — any authenticated user may create.
  await client
    .when({ method: "POST", path: "/api/products" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const guard = requireAuth(request);
      if (guard.error) return guard.error;

      const body = jsonBody(request);
      if (!body.ok) {
        return json(400, { error: `Request body is ${body.reason} JSON` });
      }

      const errors = store.validateProduct(body.value);
      if (errors.length > 0) {
        // 422, not 400: the request parsed fine, the content is what's wrong.
        return json(422, { error: "Validation failed", details: errors });
      }

      const product = store.createProduct(body.value);
      return json(201, product, { Location: [`/api/products/${product.id}`] });
    });

  // GET /api/products/:id
  await client
    .when({ method: "GET", path: "/api/products/[^/]+" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const resolved = productIdFrom(request);
      if (resolved.error) return resolved.error;

      const product = store.findProduct(resolved.id);
      if (!product) {
        return json(404, { error: `Product ${resolved.id} not found` });
      }
      return json(200, product);
    });

  // PUT /api/products/:id — full replace, so the payload must be complete.
  await client
    .when({ method: "PUT", path: "/api/products/[^/]+" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const guard = requireAuth(request);
      if (guard.error) return guard.error;

      const resolved = productIdFrom(request);
      if (resolved.error) return resolved.error;

      const body = jsonBody(request);
      if (!body.ok) {
        return json(400, { error: `Request body is ${body.reason} JSON` });
      }

      const errors = store.validateProduct(body.value);
      if (errors.length > 0) {
        return json(422, { error: "Validation failed", details: errors });
      }

      const product = store.replaceProduct(resolved.id, body.value);
      if (!product) {
        return json(404, { error: `Product ${resolved.id} not found` });
      }
      return json(200, product);
    });

  // DELETE /api/products/:id — admin only, so 401 and 403 are both reachable.
  await client
    .when({ method: "DELETE", path: "/api/products/[^/]+" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const guard = requireAuth(request, { role: "admin" });
      if (guard.error) return guard.error;

      const resolved = productIdFrom(request);
      if (resolved.error) return resolved.error;

      if (!store.deleteProduct(resolved.id)) {
        return json(404, { error: `Product ${resolved.id} not found` });
      }
      // 204 carries no body — a test asserting on res.getBody() must expect that.
      return { statusCode: 204 };
    });

  // POST /api/reset — put the mock back into its known starting state.
  await client
    .when({ method: "POST", path: "/api/reset" })
    .withTimes(ALWAYS)
    .callback(() => {
      const count = store.resetProducts();
      rateLimitHits = 0;
      return json(200, { reset: true, products: count, rateLimitHits });
    });
}

/* -------------------------------------------------------------------------- */
/* Edge cases: slow responses, rate limiting, arbitrary statuses, non-JSON      */
/* -------------------------------------------------------------------------- */

async function registerEdgeCaseExpectations(client) {
  // GET /api/slow — always takes ~2s. The delay is set on the expectation
  // because a .callback() handler must return immediately.
  await client
    .when({ method: "GET", path: "/api/slow" })
    .withTimes(ALWAYS)
    .respond({
      statusCode: 200,
      body: { json: { message: "Sorry for the wait", delayMs: 2000 } },
      delay: { timeUnit: "MILLISECONDS", value: 2000 },
    });

  // GET /api/rate-limited — 3 calls succeed, every further call is 429.
  await client
    .when({ method: "GET", path: "/api/rate-limited" })
    .withTimes(ALWAYS)
    .callback(() => {
      rateLimitHits++;

      if (rateLimitHits > RATE_LIMIT) {
        return {
          statusCode: 429,
          headers: {
            "Retry-After": ["2"],
            "X-RateLimit-Limit": [String(RATE_LIMIT)],
            "X-RateLimit-Remaining": ["0"],
          },
          body: { json: { error: "Too many requests", retryAfterSeconds: 2 } },
        };
      }

      return json(
        200,
        { ok: true, call: rateLimitHits },
        {
          "X-RateLimit-Limit": [String(RATE_LIMIT)],
          "X-RateLimit-Remaining": [String(RATE_LIMIT - rateLimitHits)],
        },
      );
    });

  // GET /api/status/:code — echo back any 3-digit status, httpbin style.
  await client
    .when({ method: "GET", path: "/api/status/[0-9]{3}" })
    .withTimes(ALWAYS)
    .callback((request) => {
      const code = Number(lastSegment(request));

      // 204 and 304 must not carry a body; sending one is a protocol error.
      if (code === 204 || code === 304) return { statusCode: code };

      return json(code, { requestedStatus: code });
    });

  // GET /api/report.csv — a deliberately non-JSON response.
  await client
    .when({ method: "GET", path: "/api/report.csv" })
    .withTimes(ALWAYS)
    .respond({
      statusCode: 200,
      headers: {
        "Content-Type": ["text/csv; charset=utf-8"],
        "Content-Disposition": ['attachment; filename="report.csv"'],
      },
      body: "category,count,value\nperyferia,2,479.49\nmonitory,2,3798\nakcesoria,2,278.99\n",
    });
}

async function registerExpectations(client) {
  // Clean slate, so restarting/reloading never stacks duplicate expectations.
  await client.reset();

  await registerLegacyExpectations(client);
  await registerAuthExpectations(client);
  await registerProductExpectations(client);
  await registerEdgeCaseExpectations(client);
}

async function main() {
  await mockServer.start_mockserver({ serverPort: PORT });
  await registerExpectations(mockServerClient(HOST, PORT));

  console.log(`MockServer listening on http://${HOST}:${PORT}`);
  console.log("");
  console.log("  Poprzednie zajęcia");
  console.log('    GET    /helloWorld            -> 200 {"message":"Hello World"}');
  console.log("    POST   /login                 -> 200 (JSON body foo/bar)");
  console.log('    POST   /validate-file         -> 200/400 (multipart "file", CSV firstName,lastName,age)');
  console.log("");
  console.log("  Autoryzacja");
  console.log("    POST   /auth/token            -> 200 accessToken / 401 (ada|linus + password123)");
  console.log("    GET    /me                    -> 200 profil / 401 (Authorization: Bearer)");
  console.log("    POST   /auth/logout           -> 204 / 401");
  console.log("    POST   /auth/login-cookie     -> 200 + Set-Cookie sessionId");
  console.log("    GET    /auth/whoami           -> 200 / 401 (cookie sessionId)");
  console.log("");
  console.log("  Produkty (stan w pamięci)");
  console.log("    GET    /api/products          -> 200 strona wyników / 400 (category,inStock,sort,page,pageSize)");
  console.log("    GET    /api/products/:id      -> 200 / 400 / 404");
  console.log("    POST   /api/products          -> 201 + Location / 401 / 422");
  console.log("    PUT    /api/products/:id      -> 200 / 401 / 404 / 422");
  console.log("    DELETE /api/products/:id      -> 204 / 401 / 403 (tylko admin) / 404");
  console.log("    POST   /api/reset             -> 200 przywraca dane startowe");
  console.log("");
  console.log("  Przypadki brzegowe");
  console.log("    GET    /api/slow              -> 200 po ~2s");
  console.log(`    GET    /api/rate-limited      -> 200 x${RATE_LIMIT}, potem 429 + Retry-After`);
  console.log("    GET    /api/status/:code      -> dowolny status HTTP");
  console.log("    GET    /api/report.csv        -> 200 text/csv");
  console.log("");
  console.log("Dashboard: http://localhost:1080/mockserver/dashboard");
  console.log("Press Ctrl+C to stop.");
}

// Shut the JVM down on Ctrl+C, otherwise it keeps port 1080 bound and the next
// run fails with a confusing "port already in use".
process.on("SIGINT", async () => {
  console.log("\nStopping MockServer...");
  await mockServer.stop_mockserver({ serverPort: PORT });
  process.exit(0);
});

main().catch(async (error) => {
  // Fail loudly and non-zero so a broken setup is never mistaken for a working one.
  console.error("Startup failed:", error.message || error);
  await mockServer.stop_mockserver({ serverPort: PORT }).catch(() => {});
  process.exit(1);
});
