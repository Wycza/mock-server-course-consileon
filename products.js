/**
 * In-memory product store behind the /api/products endpoints.
 *
 * The store is deliberately stateful: POST/PUT/DELETE really change what the
 * next GET returns. That is the point — it lets the exercises show why a test
 * suite needs a known starting state (POST /api/reset) instead of relying on
 * whatever the previous request left behind.
 */

const CATEGORIES = ["peryferia", "monitory", "akcesoria"];
const SORTABLE = ["name", "price", "id"];
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 3;

const SEED = [
  { id: 1, name: "Klawiatura mechaniczna", category: "peryferia", price: 349.99, inStock: true },
  { id: 2, name: "Mysz bezprzewodowa", category: "peryferia", price: 129.5, inStock: true },
  { id: 3, name: 'Monitor 27"', category: "monitory", price: 1299.0, inStock: false },
  { id: 4, name: "Podkładka XXL", category: "akcesoria", price: 79.0, inStock: true },
  { id: 5, name: "Hub USB-C", category: "akcesoria", price: 199.99, inStock: true },
  { id: 6, name: 'Monitor 34" ultrawide', category: "monitory", price: 2499.0, inStock: true },
];

let products = [];
let nextId = 1;

/** Restore the seed data. Returns how many products the store now holds. */
function resetProducts() {
  products = SEED.map((product) => ({ ...product }));
  nextId = products.length + 1;
  return products.length;
}

resetProducts();

/** Parse "12" but reject "12abc", "" and "1.5" — Number() alone accepts too much. */
function toInteger(value) {
  return /^-?\d+$/.test(String(value).trim()) ? Number(value) : NaN;
}

/**
 * Validate the query string of GET /api/products.
 *
 * Malformed *query* is a 400 (the client asked a question the API cannot
 * parse); an invalid *body* is a 422 (well-formed request, bad content).
 * Keeping the two apart is one of the things the exercise asks students to
 * notice.
 *
 * @returns {{errors: Array<{param: string, message: string}>, options: object}}
 */
function parseListQuery(query) {
  const errors = [];
  const options = {
    category: undefined,
    inStock: undefined,
    sort: "id",
    direction: "asc",
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  if (query.category !== undefined) {
    if (!CATEGORIES.includes(query.category)) {
      errors.push({
        param: "category",
        message: `Must be one of ${CATEGORIES.join(", ")}, got "${query.category}"`,
      });
    } else {
      options.category = query.category;
    }
  }

  if (query.inStock !== undefined) {
    if (query.inStock !== "true" && query.inStock !== "false") {
      errors.push({
        param: "inStock",
        message: `Must be true or false, got "${query.inStock}"`,
      });
    } else {
      options.inStock = query.inStock === "true";
    }
  }

  if (query.sort !== undefined) {
    const descending = query.sort.startsWith("-");
    const field = descending ? query.sort.slice(1) : query.sort;

    if (!SORTABLE.includes(field)) {
      errors.push({
        param: "sort",
        message: `Must be one of ${SORTABLE.join(", ")} (prefix with - for descending), got "${query.sort}"`,
      });
    } else {
      options.sort = field;
      options.direction = descending ? "desc" : "asc";
    }
  }

  if (query.page !== undefined) {
    const page = toInteger(query.page);
    if (!Number.isInteger(page) || page < 1) {
      errors.push({ param: "page", message: `Must be an integer >= 1, got "${query.page}"` });
    } else {
      options.page = page;
    }
  }

  if (query.pageSize !== undefined) {
    const pageSize = toInteger(query.pageSize);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
      errors.push({
        param: "pageSize",
        message: `Must be an integer between 1 and ${MAX_PAGE_SIZE}, got "${query.pageSize}"`,
      });
    } else {
      options.pageSize = pageSize;
    }
  }

  return { errors, options };
}

/** Filter + sort + paginate. A page past the end is an empty list, not a 404. */
function listProducts(options) {
  let items = products.slice();

  if (options.category !== undefined) {
    items = items.filter((product) => product.category === options.category);
  }
  if (options.inStock !== undefined) {
    items = items.filter((product) => product.inStock === options.inStock);
  }

  items.sort((a, b) => {
    const left = a[options.sort];
    const right = b[options.sort];
    const comparison =
      typeof left === "string" ? left.localeCompare(right, "pl") : left - right;
    return options.direction === "desc" ? -comparison : comparison;
  });

  const total = items.length;
  const start = (options.page - 1) * options.pageSize;

  return {
    items: items.slice(start, start + options.pageSize),
    page: options.page,
    pageSize: options.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / options.pageSize)),
  };
}

function findProduct(id) {
  return products.find((product) => product.id === id) || null;
}

/**
 * Validate a product payload for POST/PUT.
 *
 * @returns {Array<{field: string, message: string}>} empty when valid
 */
function validateProduct(payload) {
  const errors = [];

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [{ field: "body", message: "Must be a JSON object" }];
  }

  const { name, category, price, inStock } = payload;

  if (typeof name !== "string" || name.trim().length < 3) {
    errors.push({ field: "name", message: "Must be a string of at least 3 characters" });
  }

  if (!CATEGORIES.includes(category)) {
    errors.push({
      field: "category",
      message: `Must be one of ${CATEGORIES.join(", ")}`,
    });
  }

  // typeof NaN === "number", so exclude it explicitly.
  if (typeof price !== "number" || Number.isNaN(price) || price <= 0) {
    errors.push({ field: "price", message: "Must be a number greater than 0" });
  } else if (Number(price.toFixed(2)) !== price) {
    errors.push({ field: "price", message: "Must have at most 2 decimal places" });
  }

  if (inStock !== undefined && typeof inStock !== "boolean") {
    errors.push({ field: "inStock", message: "Must be a boolean when present" });
  }

  return errors;
}

function createProduct(payload) {
  const product = {
    id: nextId++,
    name: payload.name.trim(),
    category: payload.category,
    price: payload.price,
    inStock: payload.inStock === undefined ? true : payload.inStock,
  };
  products.push(product);
  return product;
}

/** PUT is a full replace: the id stays, every other field comes from the payload. */
function replaceProduct(id, payload) {
  const index = products.findIndex((product) => product.id === id);
  if (index === -1) return null;

  products[index] = {
    id,
    name: payload.name.trim(),
    category: payload.category,
    price: payload.price,
    inStock: payload.inStock === undefined ? true : payload.inStock,
  };
  return products[index];
}

function deleteProduct(id) {
  const index = products.findIndex((product) => product.id === id);
  if (index === -1) return false;
  products.splice(index, 1);
  return true;
}

module.exports = {
  CATEGORIES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  toInteger,
  resetProducts,
  parseListQuery,
  listProducts,
  findProduct,
  validateProduct,
  createProduct,
  replaceProduct,
  deleteProduct,
};
