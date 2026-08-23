import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createOrchestratorServer } from "../src/server.mjs";
import { listProjects } from "../src/core.mjs";
import { verifyAuditChain } from "../src/audit-chain.mjs";
import { getProjectRelationships, replaceProjectRelationships } from "../src/project-relations.mjs";

console.log("Running project-relations.test.mjs...");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-relations-"));
const vaultRoot = path.join(root, "vault");
const runsRoot = path.join(root, "runs");
const repositories = {
  frontend: path.join(root, "frontend"),
  backend: path.join(root, "backend"),
};
for (const [projectId, repository] of Object.entries(repositories)) {
  fs.mkdirSync(path.join(vaultRoot, "02-Projects", projectId), { recursive: true });
  fs.mkdirSync(repository, { recursive: true });
  fs.writeFileSync(path.join(repository, "marker.txt"), `${projectId}-source\n`);
  fs.writeFileSync(path.join(vaultRoot, "02-Projects", projectId, "project.md"), `---\ntitle: ${projectId}\ntype: project\nproject_id: ${projectId}\n---\n# ${projectId}\n`);
}
fs.writeFileSync(path.join(vaultRoot, "project-registry.md"), [
  "# Project Registry",
  "| project_id | project_page | repository | agent | graphify | graphify_output |",
  "|---|---|---|---|---|---|",
  `| frontend | [[02-Projects/frontend/project.md]] | ${repositories.frontend} | agy | false | ${repositories.frontend}/graph.json |`,
  `| backend | [[02-Projects/backend/project.md]] | ${repositories.backend} | agy | false | ${repositories.backend}/graph.json |`,
].join("\n"));

function request({ method = "GET", requestPath, port, token, session, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (session && ["POST", "PUT", "DELETE"].includes(method)) {
      requestHeaders["X-Operator-Session"] = session.sessionId;
      requestHeaders["X-Action-Nonce"] = session.actionNonce;
    }
    if (body !== null) requestHeaders["Content-Type"] = "application/json";
    const req = http.request({ hostname: "127.0.0.1", port, path: requestPath, method, headers: requestHeaders }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.on("error", reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

let server;
try {
  const sourceSnapshots = Object.fromEntries(Object.entries(repositories).map(([id, repository]) => [id, fs.readFileSync(path.join(repository, "marker.txt"), "utf8")]));
  const initial = getProjectRelationships({ vaultRoot, projectId: "frontend" });
  assert.deepEqual(initial.relationships, []);
  assert.deepEqual(initial.registeredProjectIds, ["backend", "frontend"]);
  assert.deepEqual(listProjects(vaultRoot).projects.find((project) => project.id === "frontend").relationships, []);

  const registryBeforeConfirmation = fs.readFileSync(path.join(vaultRoot, "project-registry.md"), "utf8");
  assert.throws(
    () => replaceProjectRelationships({ vaultRoot, runsRoot, projectId: "frontend", relationships: [], confirmed: false, confirmedBy: "local:test" }),
    (error) => error.code === "HUMAN_CONFIRMATION_REQUIRED",
  );
  assert.equal(fs.readFileSync(path.join(vaultRoot, "project-registry.md"), "utf8"), registryBeforeConfirmation);

  const saved = replaceProjectRelationships({
    vaultRoot,
    runsRoot,
    projectId: "frontend",
    confirmed: true,
    confirmedBy: "local:test",
    relationships: [
      { type: "CONSUMES_API", targetProjectId: "backend", contractPaths: ["z/openapi.yaml", "a/client.ts", "a/client.ts"], verification: ["test:contract", "test:contract"] },
      { type: "CONSUMES_API", targetProjectId: "backend", contractPaths: ["z/openapi.yaml", "a/client.ts"], verification: ["test:contract"] },
    ],
  });
  assert.equal(saved.action, "PROJECT_RELATIONSHIPS_REPLACED");
  assert.equal(saved.relationships.length, 1);
  assert.deepEqual(saved.relationships[0].contractPaths, ["a/client.ts", "z/openapi.yaml"]);
  assert.deepEqual(saved.relationships[0].verification, ["test:contract"]);
  assert.match(fs.readFileSync(path.join(vaultRoot, "project-registry.md"), "utf8"), /relationships/);
  assert.deepEqual(getProjectRelationships({ vaultRoot, projectId: "frontend" }).relationships, saved.relationships);
  assert.deepEqual(getProjectRelationships({ vaultRoot, projectId: "frontend" }).effectiveRelationships, saved.relationships);
  const backendRelationships = getProjectRelationships({ vaultRoot, projectId: "backend" });
  assert.deepEqual(backendRelationships.relationships, []);
  assert.deepEqual(backendRelationships.incomingRelationships, [{ type: "PROVIDES_API", targetProjectId: "frontend", contractPaths: ["a/client.ts", "z/openapi.yaml"], verification: ["test:contract"] }]);
  assert.deepEqual(backendRelationships.effectiveRelationships, backendRelationships.incomingRelationships);
  assert.deepEqual(listProjects(vaultRoot).projects.find((project) => project.id === "frontend").relationships, saved.relationships);
  for (const [id, repository] of Object.entries(repositories)) assert.equal(fs.readFileSync(path.join(repository, "marker.txt"), "utf8"), sourceSnapshots[id]);

  assert.throws(
    () => replaceProjectRelationships({
      vaultRoot,
      runsRoot,
      projectId: "backend",
      confirmed: true,
      confirmedBy: "local:test",
      relationships: [{ type: "PROVIDES_API", targetProjectId: "frontend" }],
    }),
    (error) => error.code === "INVERSE_RELATIONSHIP_CONFLICT",
  );
  assert.throws(
    () => replaceProjectRelationships({ vaultRoot, runsRoot, projectId: "frontend", confirmed: true, confirmedBy: "local:test", relationships: [{ type: "DEPENDS_ON", targetProjectId: "missing" }] }),
    (error) => error.code === "TARGET_PROJECT_NOT_REGISTERED",
  );
  assert.equal(verifyAuditChain(runsRoot).valid, true);

  server = createOrchestratorServer({ vaultRoot, runsRoot, port: 0, host: "127.0.0.1" });
  await server.start();
  const port = server.server.address().port;
  const token = server.token;
  const sessionResponse = await request({ requestPath: "/api/auth/session", port, token });
  assert.equal(sessionResponse.status, 200);
  let session = sessionResponse.data.data;

  const getResponse = await request({ requestPath: "/api/projects/frontend/relationships", port, token });
  assert.equal(getResponse.status, 200);
  assert.deepEqual(getResponse.data.data.relationships, saved.relationships);
  const backendGetResponse = await request({ requestPath: "/api/projects/backend/relationships", port, token });
  assert.equal(backendGetResponse.status, 200);
  assert.deepEqual(backendGetResponse.data.data.effectiveRelationships, backendRelationships.effectiveRelationships);

  const confirmationResponse = await request({
    method: "PUT",
    requestPath: "/api/projects/frontend/relationships",
    port,
    token,
    session,
    headers: { "Idempotency-Key": "relations-confirmation-required" },
    body: { relationships: [], confirmed: false },
  });
  session.actionNonce = confirmationResponse.headers["x-action-nonce"] ?? session.actionNonce;
  assert.equal(confirmationResponse.status, 409);
  assert.equal(confirmationResponse.data.error.details.code, "HUMAN_CONFIRMATION_REQUIRED");

  const putResponse = await request({
    method: "PUT",
    requestPath: "/api/projects/frontend/relationships",
    port,
    token,
    session,
    headers: { "Idempotency-Key": "relations-clear-v1" },
    body: { relationships: [], confirmed: true },
  });
  session.actionNonce = putResponse.headers["x-action-nonce"] ?? session.actionNonce;
  assert.equal(putResponse.status, 200);
  assert.equal(putResponse.data.data.changed, true);
  assert.deepEqual((await request({ requestPath: "/api/projects/frontend/relationships", port, token })).data.data.relationships, []);
} finally {
  if (server) await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("project-relations.test.mjs: All tests passed!");
