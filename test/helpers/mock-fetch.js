function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function parseRequestBody(body) {
  if (body === undefined) return undefined;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function serializeResponseBody(step) {
  if (hasOwn(step, "json")) {
    const value = JSON.stringify(step.json);
    return value === undefined ? "" : value;
  }
  if (!hasOwn(step, "body") || step.body === undefined) return "";
  if (typeof step.body === "string") return step.body;
  if (step.body instanceof Uint8Array) return new TextDecoder().decode(step.body);
  const value = JSON.stringify(step.body);
  return value === undefined ? "" : value;
}

function makeResponse(step) {
  const status = step.status ?? 200;
  const bodyText = serializeResponseBody(step);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(step.headers ?? {}),
    async text() {
      return bodyText;
    },
    async json() {
      return JSON.parse(bodyText);
    },
  };
}

export function createMockFetch(responseScript = []) {
  const script = [...responseScript];
  const calls = [];
  let nextResponse = 0;

  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method ?? "GET",
      headers: normalizeHeaders(options.headers),
      body: parseRequestBody(options.body),
    });

    if (nextResponse >= script.length) {
      throw new Error(`Mock fetch script exhausted at call ${nextResponse + 1}`);
    }
    const step = script[nextResponse++];
    if (hasOwn(step, "throw")) throw step.throw;
    return makeResponse(step);
  };

  fetchImpl.calls = calls;
  fetchImpl.fetch = fetchImpl;
  fetchImpl.fetchImpl = fetchImpl;
  return fetchImpl;
}

export class MockFetch {
  constructor(responseScript = []) {
    const fetchImpl = createMockFetch(responseScript);
    this.calls = fetchImpl.calls;
    this.fetch = fetchImpl;
    this.fetchImpl = fetchImpl;
  }
}

export default createMockFetch;
