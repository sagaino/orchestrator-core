import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Handles saving uploaded UI mockup images and project assets
 */
export async function saveUploadedAsset({
  vaultRoot,
  projectRepository = null,
  type = "MOCKUP", // "MOCKUP" | "PROJECT_ASSET"
  fileName,
  base64Data,
  targetSubDir = "src/assets/images",
}) {
  if (!fileName || typeof fileName !== "string") {
    throw new Error("File name tidak valid.");
  }
  if (!base64Data || typeof base64Data !== "string") {
    throw new Error("Base64 data tidak boleh kosong.");
  }

  // Strip data URL prefix if present (e.g. data:image/png;base64,...)
  const cleanBase64 = base64Data.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, "");
  const buffer = Buffer.from(cleanBase64, "base64");

  const ext = path.extname(fileName) || ".png";
  const baseName = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const uniqueSuffix = randomUUID().slice(0, 6);

  if (type === "MOCKUP") {
    // Save to Vault: 03-Sources/assets/ui-mockups/<date>-<name>-<suffix>.<ext>
    const saveDir = path.join(vaultRoot, "03-Sources", "assets", "ui-mockups");
    fs.mkdirSync(saveDir, { recursive: true });

    const finalFileName = `${datePrefix}-${baseName}-${uniqueSuffix}${ext}`;
    const absolutePath = path.join(saveDir, finalFileName);
    fs.writeFileSync(absolutePath, buffer);

    const relativeVaultPath = path.join("03-Sources", "assets", "ui-mockups", finalFileName).split(path.sep).join("/");
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
    if (!projectRepository || !fs.existsSync(projectRepository)) {
      throw new Error("Project repository tidak valid untuk menyimpan asset produksi.");
    }

    // Save directly inside project repo e.g. <project>/src/assets/images/<filename>
    const saveDir = path.join(projectRepository, targetSubDir);
    fs.mkdirSync(saveDir, { recursive: true });

    const finalFileName = `${baseName}${ext}`;
    const absolutePath = path.join(saveDir, finalFileName);
    fs.writeFileSync(absolutePath, buffer);

    const relativeProjectPath = path.join(targetSubDir, finalFileName).split(path.sep).join("/");
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
