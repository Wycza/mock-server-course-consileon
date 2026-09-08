/**
 * CSV parsing and validation for the POST /validate-file mock.
 *
 * Hand-rolled on purpose: the mock server has no dependencies beyond
 * mockserver-client/mockserver-node, and this only needs RFC 4180 basics.
 */

const EXPECTED_HEADERS = ["firstName", "lastName", "age"];

// A ZIP local-file header — an .xlsx renamed to .csv starts with this, which is
// by far the most common reason "my CSV won't parse".
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function looksLikeZip(buffer) {
  return buffer.length >= 4 && buffer.slice(0, 4).equals(ZIP_SIGNATURE);
}

/** Decode to text, dropping a UTF-8 BOM so the first header isn't "\uFEFFfirstName". */
function decode(buffer) {
  const text = buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse CSV text into rows of fields. Handles quoted fields, "" escapes,
 * embedded commas/newlines, and CRLF or LF line endings.
 *
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++; // consume the escaped quote
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Trailing field/row, unless the file just ended with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Ignore blank trailing lines (a single empty field and nothing else).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Validate an uploaded CSV against the firstName,lastName,age schema.
 *
 * @param {Buffer} buffer raw bytes of the uploaded file
 * @returns {{valid: boolean, errors: Array<{row?: number, column?: string, message: string}>, rowCount: number, rows: Array<object>}}
 */
function validateCsv(buffer) {
  const errors = [];

  if (!buffer || buffer.length === 0) {
    return { valid: false, errors: [{ message: "File is empty" }], rowCount: 0, rows: [] };
  }

  if (looksLikeZip(buffer)) {
    return {
      valid: false,
      errors: [
        {
          message:
            "File is a ZIP/XLSX workbook, not CSV — re-save it as CSV (Excel: Save As > CSV UTF-8)",
        },
      ],
      rowCount: 0,
      rows: [],
    };
  }

  const parsed = parseCsv(decode(buffer));

  if (parsed.length === 0) {
    return { valid: false, errors: [{ message: "File is empty" }], rowCount: 0, rows: [] };
  }

  // Validate headers.
  const headers = parsed[0].map((h) => h.trim());
  const headersMatch =
    headers.length === EXPECTED_HEADERS.length &&
    headers.every((h, i) => h === EXPECTED_HEADERS[i]);

  if (!headersMatch) {
    return {
      valid: false,
      errors: [
        {
          row: 1,
          message: `Expected headers ${EXPECTED_HEADERS.join(",")} but got ${headers.join(",")}`,
        },
      ],
      rowCount: 0,
      rows: [],
    };
  }

  const dataRows = parsed.slice(1);
  if (dataRows.length === 0) {
    errors.push({ message: "File has headers but no data rows" });
  }

  // Validate rows. Row numbers are 1-based and include the header row, so they
  // line up with what the user sees in a spreadsheet or text editor.
  const rows = [];
  dataRows.forEach((fields, index) => {
    const rowNumber = index + 2;

    if (fields.length !== EXPECTED_HEADERS.length) {
      errors.push({
        row: rowNumber,
        message: `Expected ${EXPECTED_HEADERS.length} columns but got ${fields.length}`,
      });
      return;
    }

    const [firstName, lastName, age] = fields.map((f) => f.trim());

    if (!firstName) {
      errors.push({ row: rowNumber, column: "firstName", message: "Must not be empty" });
    }
    if (!lastName) {
      errors.push({ row: rowNumber, column: "lastName", message: "Must not be empty" });
    }
    if (!/^\d+$/.test(age)) {
      errors.push({
        row: rowNumber,
        column: "age",
        message: `Must be a whole number, got "${age}"`,
      });
    } else if (Number(age) > 150) {
      errors.push({ row: rowNumber, column: "age", message: `Must be 0-150, got ${age}` });
    }

    rows.push({ firstName, lastName, age: Number(age) });
  });

  return { valid: errors.length === 0, errors, rowCount: rows.length, rows };
}

module.exports = { parseCsv, validateCsv, looksLikeZip, EXPECTED_HEADERS };
