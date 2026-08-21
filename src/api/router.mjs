export function sendJson(res, statusCode, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

export function sendError(res, statusCode, message, details = null, headers = {}) {
  sendJson(
    res,
    statusCode,
    {
      success: false,
      error: {
        message,
        statusCode,
        ...(details ? { details } : {}),
      },
    },
    headers
  );
}

export function parseJsonBody(req, { maxSizeBytes = 8 * 1024 * 1024 } = {}) {
  if (Object.hasOwn(req, "orchestratorJsonBody")) {
    return Promise.resolve(req.orchestratorJsonBody);
  }
  if (req.orchestratorJsonBodyPromise) return req.orchestratorJsonBodyPromise;

  req.orchestratorJsonBodyPromise = new Promise((resolve, reject) => {
    let raw = "";
    let byteLength = 0;
    let exceeded = false;

    req.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maxSizeBytes) {
        exceeded = true;
        return;
      }
      if (!exceeded) raw += chunk;
    });

    req.on("end", () => {
      if (exceeded) {
        const error = new Error(`Payload size exceeded limit of ${maxSizeBytes} bytes`);
        error.statusCode = 413;
        reject(error);
        return;
      }
      req.orchestratorRawJsonBody = raw;
      if (!raw.trim()) {
        req.orchestratorJsonBody = {};
        resolve(req.orchestratorJsonBody);
        return;
      }
      try {
        req.orchestratorJsonBody = JSON.parse(raw);
        resolve(req.orchestratorJsonBody);
      } catch (err) {
        const error = new Error(`Invalid JSON body: ${err.message}`);
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
  return req.orchestratorJsonBodyPromise;
}

function matchRoutePattern(pattern, pathname) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];

    if (patternPart.startsWith(":")) {
      const paramName = patternPart.slice(1);
      try {
        params[paramName] = decodeURIComponent(pathPart);
      } catch {
        return null;
      }
    } else if (patternPart !== pathPart) {
      return null;
    }
  }

  return params;
}

export class Router {
  constructor() {
    this.routes = [];
  }

  get(pattern, handler) {
    this.routes.push({ method: "GET", pattern, handler });
  }

  post(pattern, handler) {
    this.routes.push({ method: "POST", pattern, handler });
  }

  put(pattern, handler) {
    this.routes.push({ method: "PUT", pattern, handler });
  }

  delete(pattern, handler) {
    this.routes.push({ method: "DELETE", pattern, handler });
  }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchRoutePattern(route.pattern, pathname);
      if (params !== null) {
        return { handler: route.handler, params, pattern: route.pattern };
      }
    }
    return null;
  }
}
