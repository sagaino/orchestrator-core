import fs from "node:fs";
import path from "node:path";

export function hardenRuntimePermissions(runsRoot, { apply = false } = {}) {
  const root = path.resolve(runsRoot);
  if (!fs.existsSync(root)) return { root, apply, directories: 0, files: 0, skippedWorkspaces: 0 };
  let directories = 0; let files = 0; let skippedWorkspaces = 0;
  const visit = (current) => {
    const relative = path.relative(root, current).replaceAll("\\", "/");
    if (relative === "workspaces" || relative.startsWith("workspaces/")) { skippedWorkspaces += 1; return; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      directories += 1;
      if (apply) fs.chmodSync(current, 0o700);
      for (const entry of fs.readdirSync(current)) visit(path.join(current, entry));
    } else if (stat.isFile()) {
      files += 1;
      if (apply) fs.chmodSync(current, 0o600);
    }
  };
  visit(root);
  return { schemaVersion: 1, action: apply ? "RUNTIME_PERMISSIONS_HARDENED" : "RUNTIME_PERMISSIONS_PREVIEWED", root, directories, files, skippedWorkspaces };
}
