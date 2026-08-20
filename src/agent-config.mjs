const VALID_EFFORTS = new Set(["low", "medium", "high"]);

export const DEFAULT_AGY_MODEL = "gemini-3.7-flash-high";
export const DEFAULT_AGY_EFFORT = "high";

export const STAGE_DEFAULT_EFFORTS = Object.freeze({
  "task-intake": "low",
  "TASK_INTAKE": "low",
  "retrospective": "low",
  "RETROSPECTIVE": "low",
  "implementation": "high",
  "recovery": "high",
});

export function detectTaskComplexity(request = "", options = {}) {
  const text = String(request).toLowerCase();
  
  // Complexity 3: HIGH (Complex architecture, major refactor, multi-module coordination, security, data integrity)
  const highKeywords = [
    // Arsitektur & Refactoring
    "arsitektur", "architecture", "refactor besar", "major refactor", "redesign total", "overhaul",
    "microservices", "monorepo", "restructure", "restrukturisasi",
    // Database & Persistence
    "migration", "migrasi", "database", "schema migration", "relational", "foreign key", "indexing",
    // Keamanan, Auth & Transaksi
    "oauth", "auth flow", "authentication", "authorization", "jwt", "session management",
    "security audit", "vulnerability", "encryption", "enkripsi", "token refresh",
    // Concurrency & State Rumit
    "race condition", "transaction", "transaksi", "deadlock", "concurrency",
    "state sync", "global store", "redux", "zustand sync", "cache invalidation",
    "optimistic update", "idempotency", "breaking change", "multi-module",
    // Integrasi Eksternal & Performance
    "payment gateway", "webhook", "realtime sync", "websocket", "memory leak", "performance bottleneck",
  ];
  if (highKeywords.some((kw) => text.includes(kw))) {
    return "high";
  }

  // Complexity 1: LOW (Simple styling, typos, text updates, single small file tweaks, minor UI fixes)
  const lowKeywords = [
    // Teks, Copywriting & Typo
    "ganti teks", "ubah teks", "edit text", "typo", "label", "wording", "placeholder",
    "rename title", "ganti judul", "terjemahan", "i18n text", "tooltip",
    // Styling, CSS & Layout Mikro
    "padding", "margin", "warna", "color", "icon", "perbaiki styling", "tweak css",
    "font-size", "border", "opacity", "shadow", "rounded", "gap", "align", "alignment",
    "z-index", "hover effect", "cursor", "hidden", "tampilkan", "sembunyikan",
    // Tweak Komponen Sederhana
    "disabled state", "readonly", "loading spinner", "ubah placeholder", "ganti icon",
    "tambah class", "tailwind class", "ganti button text", "tambah atribut", "tweak layout",
  ];
  const allowedPathsCount = Array.isArray(options.allowedPaths) ? options.allowedPaths.length : 0;
  if (lowKeywords.some((kw) => text.includes(kw)) || (allowedPathsCount === 1 && text.length < 150)) {
    return "low";
  }

  // Complexity 2: MEDIUM (Default for new features, standard slicing, API hooks, CRUD)
  return "medium";
}

export function resolveAgyConfig(env = process.env, stage = "implementation", context = {}) {
  const rawModel = String(env.ORCHESTRATOR_AGY_MODEL ?? DEFAULT_AGY_MODEL).trim();
  if (!rawModel) throw new Error("ORCHESTRATOR_AGY_MODEL tidak boleh kosong.");

  let defaultForStage = STAGE_DEFAULT_EFFORTS[stage] ?? DEFAULT_AGY_EFFORT;
  
  if (stage === "implementation" && context.request) {
    // Dynamically route effort based on task complexity
    defaultForStage = detectTaskComplexity(context.request, context);
  } else if ((stage === "task-intake" || stage === "TASK_INTAKE") && env.ORCHESTRATOR_INTAKE_EFFORT) {
    defaultForStage = env.ORCHESTRATOR_INTAKE_EFFORT;
  } else if ((stage === "retrospective" || stage === "RETROSPECTIVE") && env.ORCHESTRATOR_RETRO_EFFORT) {
    defaultForStage = env.ORCHESTRATOR_RETRO_EFFORT;
  }

  const effort = String(env.ORCHESTRATOR_AGY_EFFORT ?? defaultForStage).trim().toLowerCase();
  if (!VALID_EFFORTS.has(effort)) {
    throw new Error(`ORCHESTRATOR_AGY_EFFORT tidak valid: ${effort}. Gunakan low, medium, atau high.`);
  }

  let model = rawModel;
  // Match model suffix with effort to prevent agy CLI conflict
  if (effort === "high") {
    if (model === "gemini-3.7-flash") model = "gemini-3.7-flash-high";
  } else if (effort === "medium") {
    if (model === "gemini-3.7-flash-high" || model === "gemini-3.7-flash-low") model = "gemini-3.7-flash-medium";
  } else if (effort === "low") {
    if (model.endsWith("-high") || model.endsWith("-medium")) {
      model = model.replace(/-(high|medium)$/, "");
    }
  }

  return { model, effort };
}

export function agyConfigArgs(config = resolveAgyConfig()) {
  return ["--model", config.model, "--effort", config.effort];
}
