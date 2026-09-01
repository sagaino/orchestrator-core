import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createOrchestratorServer } from "../../src/server.mjs";
import { assertNoLeakageToRealRepositories } from "./planning-quality-fixture.mjs";

export async function createAiOsE2eHarness({ port = 0, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-os-e2e-"));
  assertNoLeakageToRealRepositories(root);

  const vaultRoot = path.join(root, "vault");
  const runsRoot = path.join(root, "runs");
  const frontendRepo = path.join(root, "frontend-app");

  fs.mkdirSync(vaultRoot, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(frontendRepo, { recursive: true });

  // Init frontend repo
  execFileSync("git", ["init", "-b", "main"], { cwd: frontendRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "E2E Runner"], { cwd: frontendRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "e2e@example.com"], { cwd: frontendRepo, stdio: "ignore" });

  fs.writeFileSync(path.join(frontendRepo, "package.json"), JSON.stringify({
    name: "frontend-app",
    version: "1.0.0",
    scripts: {
      typecheck: "node --version",
      lint: "node -e \"console.log('lint ok')\"",
      build: "node --version",
    },
    devDependencies: {
      vite: "^5.0.0",
      react: "^18.0.0",
      typescript: "^5.0.0",
    },
  }, null, 2));

  fs.mkdirSync(path.join(frontendRepo, "src"), { recursive: true });
  fs.writeFileSync(path.join(frontendRepo, "src", "App.tsx"), "export const App = () => <div>App</div>;\n");
  execFileSync("git", ["add", "."], { cwd: frontendRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: frontendRepo, stdio: "ignore" });

  // Vault setup
  fs.mkdirSync(path.join(vaultRoot, "01-Knowledge", "rules"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", "frontend-app", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(vaultRoot, "03-Sources"), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(vaultRoot, "wiki-log.md"), "# Wiki Log\n");

  fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
    "# Project Registry",
    "| project_id | project_page | repository | agent | graphify | graphify_output |",
    "|---|---|---|---|---|---|",
    `| frontend-app | [[02-Projects/frontend-app/project.md]] | ${frontendRepo} | agy | false | ${frontendRepo}/graph.json |`,
  ].join("\n"));

  fs.writeFileSync(path.join(vaultRoot, "02-Projects", "frontend-app", "project.md"), [
    "---",
    "title: Frontend App",
    "blueprint: frontend-vite",
    "verification_defaults:",
    "  - typecheck",
    "  - lint",
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
    "Frontend Application.",
  ].join("\n"));

  const service = createOrchestratorServer({
    vaultRoot,
    runsRoot,
    port: 0,
    host: "127.0.0.1",
    apiToken: "e".repeat(64),
    services: {
      objectivesEnabled: () => true,
      crossProjectEnabled: () => false,
    },
  });

  await service.start();
  const serverPort = service.server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  const sessionRes = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Authorization: `Bearer ${service.token}` },
  });
  const sessionData = await sessionRes.json();
  const operatorSession = sessionData.data;

  const requestJson = async (endpoint, { method = "GET", body = null, headers = {} } = {}) => {
    const url = new URL(endpoint, baseUrl);
    const reqHeaders = {
      Authorization: `Bearer ${service.token}`,
      ...headers,
    };
    if (operatorSession && ["POST", "PUT", "DELETE"].includes(method)) {
      reqHeaders["X-Operator-Session"] = operatorSession.sessionId;
      reqHeaders["X-Action-Nonce"] = operatorSession.actionNonce;
    }
    if (body) reqHeaders["Content-Type"] = "application/json";

    const res = await fetch(url.toString(), {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    const nextNonce = res.headers.get("x-action-nonce");
    if (nextNonce && operatorSession) {
      operatorSession.actionNonce = nextNonce;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    return {
      status: res.status,
      headers: res.headers,
      data,
    };
  };

  const cleanup = async () => {
    await service.stop();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  };

  return {
    root,
    vaultRoot,
    runsRoot,
    frontendRepo,
    baseUrl,
    service,
    operatorSession,
    requestJson,
    cleanup,
  };
}
