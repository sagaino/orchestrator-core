import path from "node:path";

const DISALLOWED_CHARS = /[;&|`$<>()\n\r]/;

/**
 * Parses and strictly validates a verification command string into executable command and arguments.
 * Supports:
 * - JavaScript/TypeScript: npm run, pnpm run, yarn, bun run, bun test, npx, deno
 * - Java/Kotlin: Maven (./mvnw, mvn), Gradle (./gradlew, gradle)
 * - Python: pytest, python -m pytest, unittest, mypy, pyright, ruff, flake8, black, poetry/pipenv/pdm run
 * - Go: go test, go build, go vet, golangci-lint, staticcheck
 * - Rust: cargo test, cargo check, cargo clippy, cargo fmt, cargo build
 * - PHP: php artisan test, composer test, phpunit, pest, phpstan, pint
 * - .NET: dotnet test, dotnet build, dotnet format
 *
 * @param {string} command - Raw command string
 * @returns {{ command: string, args: string[], scriptName: string }}
 */
export function parseVerificationCommand(command) {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) throw new Error("Verification command tidak boleh kosong.");
  if (DISALLOWED_CHARS.test(trimmed)) {
    throw new Error(`Verification command mengandung karakter tidak aman: ${command}`);
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const head = tokens[0];

  // 1. Node.js / NPM / PNPM / Yarn / Bun / Deno / NPX
  if (head === "npm" && tokens[1] === "run" && tokens[2] && tokens.length === 3) {
    if (!/^[A-Za-z0-9:_-]+$/.test(tokens[2])) throw new Error(`Invalid npm script name: ${tokens[2]}`);
    return { command: "npm", args: ["run", tokens[2]], scriptName: tokens[2] };
  }
  if (head === "pnpm" && tokens[1] === "run" && tokens[2] && tokens.length === 3) {
    if (!/^[A-Za-z0-9:_-]+$/.test(tokens[2])) throw new Error(`Invalid pnpm script name: ${tokens[2]}`);
    return { command: "pnpm", args: ["run", tokens[2]], scriptName: tokens[2] };
  }
  if (head === "yarn" && tokens[1] && tokens.length === 2) {
    if (!/^[A-Za-z0-9:_-]+$/.test(tokens[1])) throw new Error(`Invalid yarn script name: ${tokens[1]}`);
    return { command: "yarn", args: [tokens[1]], scriptName: tokens[1] };
  }
  if (head === "bun" && tokens[1] === "run" && tokens[2] && tokens.length === 3) {
    if (!/^[A-Za-z0-9:_-]+$/.test(tokens[2])) throw new Error(`Invalid bun script name: ${tokens[2]}`);
    return { command: "bun", args: ["run", tokens[2]], scriptName: tokens[2] };
  }
  if (head === "bun" && tokens[1] === "test") {
    return { command: "bun", args: tokens.slice(1), scriptName: "test" };
  }
  if (head === "deno" && (tokens[1] === "test" || tokens[1] === "check" || tokens[1] === "lint")) {
    return { command: "deno", args: tokens.slice(1), scriptName: tokens[1] };
  }
  if (head === "npx" && (tokens[1] === "tsc" || tokens[1] === "vitest" || tokens[1] === "jest" || tokens[1] === "eslint" || tokens[1] === "prettier")) {
    return { command: "npx", args: tokens.slice(1), scriptName: tokens[1] };
  }

  // 2. Java & Kotlin (Maven & Gradle)
  if (head === "./mvnw" || head === "mvn") {
    const goal = tokens[1] ?? "";
    const allowedGoals = ["test", "compile", "test-compile", "verify", "package", "check", "checkstyle:check", "spotless:check", "pmd:check", "clean"];
    if (!goal || !allowedGoals.some((g) => goal === g || goal.startsWith(g) || goal.startsWith("-D") || goal.startsWith("-P") || goal.startsWith("-q"))) {
      throw new Error(`Maven goal tidak didukung: ${trimmed}`);
    }
    return { command: head, args: tokens.slice(1), scriptName: goal.replace(/^clean\s+/, "") || "mvn" };
  }
  if (head === "./gradlew" || head === "gradle") {
    const task = tokens[1] ?? "";
    const allowedTasks = ["test", "check", "build", "compileJava", "compileKotlin", "spotlessCheck", "ktlintCheck", "detekt", "classes", "testClasses"];
    if (!task || !allowedTasks.some((t) => task === t || task.startsWith(t) || task.startsWith("-x") || task.startsWith("-P") || task.startsWith("--"))) {
      throw new Error(`Gradle task tidak didukung: ${trimmed}`);
    }
    return { command: head, args: tokens.slice(1), scriptName: task || "gradle" };
  }

  // 3. Python
  if (head === "pytest" || head === "py.test") {
    return { command: head, args: tokens.slice(1), scriptName: "pytest" };
  }
  if ((head === "python" || head === "python3") && tokens[1] === "-m" && (tokens[2] === "pytest" || tokens[2] === "unittest" || tokens[2] === "compileall")) {
    return { command: head, args: tokens.slice(1), scriptName: tokens[2] };
  }
  if (head === "mypy" || head === "pyright" || head === "flake8" || head === "black" || head === "isort" || head === "ruff") {
    return { command: head, args: tokens.slice(1), scriptName: head };
  }
  if ((head === "poetry" || head === "pipenv" || head === "pdm") && tokens[1] === "run" && (tokens[2] === "pytest" || tokens[2] === "mypy" || tokens[2] === "ruff" || tokens[2] === "flake8" || tokens[2] === "test")) {
    return { command: head, args: tokens.slice(1), scriptName: tokens[2] };
  }

  // 4. Go (Golang)
  if (head === "go" && (tokens[1] === "test" || tokens[1] === "build" || tokens[1] === "vet")) {
    return { command: "go", args: tokens.slice(1), scriptName: `go-${tokens[1]}` };
  }
  if (head === "golangci-lint" || head === "staticcheck") {
    return { command: head, args: tokens.slice(1), scriptName: head };
  }

  // 5. Rust
  if (head === "cargo" && (tokens[1] === "test" || tokens[1] === "check" || tokens[1] === "clippy" || tokens[1] === "fmt" || tokens[1] === "build")) {
    return { command: "cargo", args: tokens.slice(1), scriptName: `cargo-${tokens[1]}` };
  }

  // 6. PHP
  if (head === "php" && tokens[1] === "artisan" && tokens[2] === "test") {
    return { command: "php", args: tokens.slice(1), scriptName: "artisan-test" };
  }
  if (head === "composer" && (tokens[1] === "test" || tokens[1] === "check")) {
    return { command: "composer", args: tokens.slice(1), scriptName: `composer-${tokens[1]}` };
  }
  if (head === "./vendor/bin/phpunit" || head === "./vendor/bin/pest" || head === "./vendor/bin/phpstan" || head === "./vendor/bin/pint") {
    return { command: head, args: tokens.slice(1), scriptName: path.basename(head) };
  }

  // 7. .NET
  if (head === "dotnet" && (tokens[1] === "test" || tokens[1] === "build" || tokens[1] === "format")) {
    return { command: "dotnet", args: tokens.slice(1), scriptName: `dotnet-${tokens[1]}` };
  }

  throw new Error(`Verification command tidak didukung: ${command}`);
}
