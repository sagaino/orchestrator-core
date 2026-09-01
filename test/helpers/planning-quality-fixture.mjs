import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function assertNoLeakageToRealRepositories(targetPath) {
  const normalized = path.resolve(String(targetPath ?? ""));
  if (normalized.includes("starter-app") && !normalized.includes("tmp")) {
    throw new Error(`SAFETY GUARD TRIGGERED: Attempted to use non-temporary starter-app path: ${normalized}`);
  }
  const tempPrefix = path.resolve(os.tmpdir());
  if (!normalized.startsWith(tempPrefix)) {
    throw new Error(`SAFETY GUARD TRIGGERED: Path ${normalized} is outside OS temporary directory ${tempPrefix}`);
  }
}

export function createPlanningQualityFixture({ prefix = "planning-quality-" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  assertNoLeakageToRealRepositories(root);

  const vaultRoot = path.join(root, "vault");
  const runsRoot = path.join(root, "runs");
  const frontendRepo = path.join(root, "frontend-app");
  const backendRepo = path.join(root, "backend-app");

  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(frontendRepo, { recursive: true });
  fs.mkdirSync(backendRepo, { recursive: true });

  // Init frontend git repo
  execFileSync("git", ["init", "-b", "main"], { cwd: frontendRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: frontendRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: frontendRepo, stdio: "ignore" });

  fs.writeFileSync(path.join(frontendRepo, "package.json"), JSON.stringify({
    name: "frontend-app",
    version: "1.0.0",
    scripts: {
      typecheck: "node --version",
      lint: "node -e \"console.log('lint ok')\"",
      build: "node --version",
      "test:e2e": "node --version",
    },
    devDependencies: {
      vite: "^5.0.0",
      react: "^18.0.0",
      typescript: "^5.0.0",
    },
  }, null, 2));

  fs.mkdirSync(path.join(frontendRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(frontendRepo, "src", "App.tsx"), "export const App = () => <div>Hello</div>;\n");
  execFileSync("git", ["add", "."], { cwd: frontendRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial frontend commit"], { cwd: frontendRepo, stdio: "ignore" });

  // Init backend git repo
  execFileSync("git", ["init", "-b", "main"], { cwd: backendRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test Runner"], { cwd: backendRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: backendRepo, stdio: "ignore" });

  fs.writeFileSync(path.join(backendRepo, "go.mod"), "module example.com/backend-app\n\ngo 1.22\n");
  fs.writeFileSync(path.join(backendRepo, "main.go"), "package main\n\nfunc main() {}\n");
  execFileSync("git", ["add", "."], { cwd: backendRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial backend commit"], { cwd: backendRepo, stdio: "ignore" });

  // Setup Vault metadata
  fs.mkdirSync(path.join(vaultRoot, "01-Knowledge", "patterns"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "frontend-app"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "backend-app"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "03-Sources"), { recursive: true });

  fs.writeFileSync(path.join(vaultRoot, "index.md"), "# Knowledge Index\n");
  fs.writeFileSync(path.join(vaultRoot, "wiki-log.md"), "# Wiki Log\n");

  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    `| frontend-app | [[02-Projects/frontend-app/project.md]] | ${frontendRepo} | agy | false | ${frontendRepo}/graph.json |`,
    `| backend-app | [[02-Projects/backend-app/project.md]] | ${backendRepo} | agy | false | ${backendRepo}/graph.json |`,
  ].join("\n"));

  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "frontend-app", "project.md"), [
    "---",
    "title: Frontend App",
    "blueprint: frontend-vite",
    "verification_defaults:",
    "  - typecheck",
    "  - build",
    "verification_policies:",
    "  typecheck:",
    "    mode: STRICT",
    "  lint:",
    "    mode: NO_NEW_FINDINGS",
    "    adapter: eslint",
    "  build:",
    "    mode: STRICT",
    "---",
    "# Frontend App",
    "Frontend Vite application.",
  ].join("\n"));

  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "backend-app", "project.md"), [
    "---",
    "title: Backend App",
    "blueprint: backend-golang",
    "verification_defaults:",
    "  - go test ./...",
    "---",
    "# Backend App",
    "Backend Golang application.",
  ].join("\n"));

  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  };

  return {
    root,
    vaultRoot,
    runsRoot,
    frontendRepo,
    backendRepo,
    cleanup,
  };
}
