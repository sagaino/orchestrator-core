import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeSafeRelativePath, resolveContainedPath } from "./security.mjs";

const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MOCKUP_RELATIVE_ROOT = "03-Sources/assets/ui-mockups";
const PROJECT_ASSET_RELATIVE_ROOT = "src/assets";
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function normalizeExtension(fileName) {
  const extension = path.extname(fileName).toLowerCase() || ".png";
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`Format asset tidak didukung: ${extension}. Gunakan PNG, JPEG, WEBP, atau GIF.`);
  }
  return extension;
}

function decodeAsset(fileName, base64Data) {
  if (!base64Data || typeof base64Data !== "string") {
    throw new Error("Base64 data tidak boleh kosong.");
  }

  const extension = normalizeExtension(fileName);
  const dataUrl = base64Data.match(/^data:([^;,]+);base64,(.*)$/s);
  const declaredMime = dataUrl?.[1]?.toLowerCase() ?? null;
  const cleanBase64 = (dataUrl?.[2] ?? base64Data).replace(/\s+/g, "");
  if (!cleanBase64 || cleanBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
    throw new Error("Base64 asset tidak valid.");
  }

  const expectedMimes = {
    ".png": ["image/png"],
    ".jpg": ["image/jpeg"],
    ".jpeg": ["image/jpeg"],
    ".webp": ["image/webp"],
    ".gif": ["image/gif"],
  }[extension];
  if (declaredMime && !expectedMimes.includes(declaredMime)) {
    throw new Error(`MIME type ${declaredMime} tidak sesuai dengan extension ${extension}.`);
  }

  const buffer = Buffer.from(cleanBase64, "base64");
  if (!buffer.length || buffer.length > MAX_ASSET_BYTES) {
    throw new Error(`Ukuran asset harus antara 1 byte dan ${MAX_ASSET_BYTES} bytes.`);
  }

  const signatures = {
    ".png": () => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ".jpg": () => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    ".jpeg": () => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    ".webp": () => buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP",
    ".gif": () => buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")),
  };
  if (!signatures[extension]()) {
    throw new Error(`Isi asset tidak cocok dengan format ${extension}.`);
  }
  return { buffer, extension };
}

function safeBaseName(fileName, extension) {
  const value = path.basename(fileName, path.extname(fileName) || extension)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (!value) throw new Error("File name tidak memiliki nama dasar yang valid.");
  return value;
}

function assertProjectAssetRelativePath(relativePath, label) {
  const normalized = normalizeSafeRelativePath(relativePath, { label });
  if (normalized !== PROJECT_ASSET_RELATIVE_ROOT && !normalized.startsWith(`${PROJECT_ASSET_RELATIVE_ROOT}/`)) {
    throw new Error(`${label} hanya diizinkan di dalam ${PROJECT_ASSET_RELATIVE_ROOT}/.`);
  }
  return normalized;
}

export function resolveMockupAssetPath(vaultRoot, relativeVaultPath, { mustExist = true } = {}) {
  const normalized = normalizeSafeRelativePath(relativeVaultPath, { label: "Mockup asset path" });
  if (!normalized.startsWith(`${MOCKUP_RELATIVE_ROOT}/`)) {
    throw new Error(`Mockup asset hanya diizinkan di dalam ${MOCKUP_RELATIVE_ROOT}/.`);
  }
  return resolveContainedPath(vaultRoot, normalized, { label: "Mockup asset path", mustExist });
}

export async function saveUploadedAsset({
  vaultRoot,
  projectRepository = null,
  type = "MOCKUP",
  fileName,
  base64Data,
  targetSubDir = "src/assets/images",
}) {
  if (!fileName || typeof fileName !== "string") throw new Error("File name tidak valid.");
  const { buffer, extension } = decodeAsset(fileName, base64Data);
  const baseName = safeBaseName(fileName, extension);
  const uniqueSuffix = randomUUID().slice(0, 8);

  if (type === "MOCKUP") {
    const saveDir = path.join(vaultRoot, ...MOCKUP_RELATIVE_ROOT.split("/"));
    fs.mkdirSync(saveDir, { recursive: true });
    const finalFileName = `${new Date().toISOString().slice(0, 10)}-${baseName}-${uniqueSuffix}${extension}`;
    const relativeVaultPath = `${MOCKUP_RELATIVE_ROOT}/${finalFileName}`;
    const absolutePath = resolveMockupAssetPath(vaultRoot, relativeVaultPath, { mustExist: false });
    fs.writeFileSync(absolutePath, buffer, { flag: "wx", mode: 0o600 });
    return {
      type: "MOCKUP",
      fileName: finalFileName,
      absolutePath,
      relativeVaultPath,
      url: `/api/assets/raw?path=${encodeURIComponent(relativeVaultPath)}`,
      sizeBytes: buffer.length,
    };
  }

  if (type === "PROJECT_ASSET") {
    if (!projectRepository || !fs.existsSync(projectRepository) || !fs.statSync(projectRepository).isDirectory()) {
      throw new Error("Project repository tidak valid untuk menyimpan asset produksi.");
    }
    const normalizedSubDir = assertProjectAssetRelativePath(targetSubDir, "Project asset directory");
    const saveDir = resolveContainedPath(projectRepository, normalizedSubDir, {
      label: "Project asset directory",
      mustExist: false,
    });
    fs.mkdirSync(saveDir, { recursive: true });
    const finalFileName = `${baseName}-${uniqueSuffix}${extension}`;
    const relativeProjectPath = `${normalizedSubDir}/${finalFileName}`;
    const absolutePath = resolveContainedPath(projectRepository, relativeProjectPath, {
      label: "Project asset path",
      mustExist: false,
    });
    fs.writeFileSync(absolutePath, buffer, { flag: "wx", mode: 0o600 });
    return {
      type: "PROJECT_ASSET",
      fileName: finalFileName,
      absolutePath,
      relativeProjectPath,
      importPath: `@/${relativeProjectPath.replace(/^src\//, "")}`,
      sizeBytes: buffer.length,
    };
  }

  throw new Error(`Asset type tidak didukung: ${type}`);
}

export async function deleteUploadedAsset({
  vaultRoot,
  projectRepository = null,
  type = "MOCKUP",
  relativeVaultPath = null,
  relativeProjectPath = null,
}) {
  if (type === "MOCKUP" && relativeVaultPath) {
    const fullPath = resolveMockupAssetPath(vaultRoot, relativeVaultPath, { mustExist: false });
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      resolveMockupAssetPath(vaultRoot, relativeVaultPath, { mustExist: true });
      fs.unlinkSync(fullPath);
      return { deleted: true, path: relativeVaultPath };
    }
    return { deleted: false, reason: "File not found" };
  }

  if (type === "PROJECT_ASSET" && projectRepository && relativeProjectPath) {
    const normalized = assertProjectAssetRelativePath(relativeProjectPath, "Project asset path");
    const fullPath = resolveContainedPath(projectRepository, normalized, {
      label: "Project asset path",
      mustExist: false,
    });
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      resolveContainedPath(projectRepository, normalized, { label: "Project asset path", mustExist: true });
      fs.unlinkSync(fullPath);
      return { deleted: true, path: relativeProjectPath };
    }
    return { deleted: false, reason: "File not found" };
  }

  return { deleted: false, reason: "Invalid parameters" };
}
