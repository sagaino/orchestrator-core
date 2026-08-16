export function sendJson(res, statusCode, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-token, Idempotency-Key",
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

export function parseJsonBody(req, { maxSizeBytes = 5 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let byteLength = 0;

    req.on("data", (chunk) => {
      byteLength += chunk.length;
      if (byteLength > maxSizeBytes) {
        reject(new Error(`Payload size exceeded limit of ${maxSizeBytes} bytes`));
        req.destroy();
        return;
      }
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
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
      params[paramName] = decodeURIComponent(pathPart);
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
