const activeFaults = new Map();

export class InjectedFaultError extends Error {
  constructor(point, { code = "EIO", message = null, details = null } = {}) {
    super(message || `Injected fault at ${point}`);
    this.name = "InjectedFaultError";
    this.code = code;
    this.faultPoint = point;
    this.details = details;
    this.injected = true;
  }
}

export function configureFaultInjection(specification = {}) {
  activeFaults.clear();
  for (const [point, raw] of Object.entries(specification)) {
    const config = typeof raw === "number" ? { remaining: raw } : { ...raw };
    activeFaults.set(point, {
      remaining: Math.max(0, Number(config.remaining ?? 1)),
      code: String(config.code ?? "EIO"),
      message: config.message ?? null,
    });
  }
}

export function clearFaultInjection() {
  activeFaults.clear();
}

export function injectFault(point, details = null) {
  const config = activeFaults.get(point);
  if (!config || config.remaining <= 0) return false;
  config.remaining -= 1;
  throw new InjectedFaultError(point, { code: config.code, message: config.message, details });
}

export function faultInjectionStatus() {
  return Object.fromEntries([...activeFaults.entries()].map(([point, config]) => [point, { ...config }]));
}
