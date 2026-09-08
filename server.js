const mockServer = require("mockserver-node");
const { mockServerClient } = require("mockserver-client");
const { extractFilePart } = require("./multipart");
const { validateCsv } = require("./csv");

const HOST = "localhost";
const PORT = 1080;

// Match for as long as the server runs. MockServer's default is
// remainingTimes: 1 — the endpoint answers once and then 404s, which makes
// re-running a Bruno request look broken for no visible reason.
const ALWAYS = { unlimited: true };

async function registerExpectations(client) {
  // Clean slate, so restarting/reloading never stacks duplicate expectations.
  await client.reset();

  // http://localhost:1080/helloworld
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
  // .respond({
  //   statusCode: 302,
  //   headers: { Location: ["https://www.mock-server.com"] },
  //   cookies: { sessionId: "2By8LOhBmaW5nZXJwcmludCIlMDAzMW" },
  // });

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
        return {
          statusCode: 400,
          body: {
            json: { error: "CSV file is required", details: [] },
          },
        };
      }

      const result = validateCsv(part.content);

      if (!result.valid) {
        return {
          statusCode: 400,
          body: {
            json: {
              error: "CSV validation failed",
              filename: part.filename,
              details: result.errors,
            },
          },
        };
      }

      return {
        statusCode: 200,
        body: {
          json: {
            success: true,
            filename: part.filename,
            rowCount: result.rowCount,
            rows: result.rows,
          },
        },
      };
    });
}

async function main() {
  await mockServer.start_mockserver({ serverPort: PORT });
  await registerExpectations(mockServerClient(HOST, PORT));

  console.log(`MockServer listening on http://${HOST}:${PORT}`);
  console.log(
    "  POST /login      -> 302 + sessionId cookie (JSON body foo/bar)",
  );
  console.log('  GET  /helloWorld -> 200 {"message":"Hello World"}');
  console.log(
    '  POST /validate-file -> 200/400 (multipart field "file", CSV firstName,lastName,age)',
  );
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
