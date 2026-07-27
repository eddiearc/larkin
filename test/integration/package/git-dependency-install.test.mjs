import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const enabled = process.env.LARKIN_RUN_GIT_DEPENDENCY_TEST === "1";

function checked(command, args, options, label) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

test.skipIf(!enabled)("Bun source dependency workflow prepares an unbuilt checkout and exposes the package bin", { timeout: 30_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-git-dependency-"));
  try {
    const sourceRepo = path.join(temp, "source");
    const consumer = path.join(temp, "consumer");
    fs.mkdirSync(sourceRepo);
    fs.mkdirSync(consumer);
    for (const relative of ["src", "assets", "scripts", "README.md", "package.json", "bun.lock"]) {
      fs.cpSync(path.join(ROOT, relative), path.join(sourceRepo, relative), { recursive: true });
    }
    checked("git", ["init", "--quiet", sourceRepo], {}, "git init source fixture");
    checked("git", ["-C", sourceRepo, "config", "user.name", "Larkin Test"], {}, "configure fixture user name");
    checked("git", ["-C", sourceRepo, "config", "user.email", "larkin-test@example.invalid"], {}, "configure fixture user email");
    checked("git", ["-C", sourceRepo, "add", "."], {}, "stage source fixture");
    checked("git", ["-C", sourceRepo, "commit", "--quiet", "-m", "source fixture"], {}, "commit source fixture");
    assert.equal(fs.existsSync(path.join(sourceRepo, "dist")), false, "Git source fixture must start without dist");

    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({
      name: "larkin-git-consumer",
      private: true,
      trustedDependencies: ["larkin"],
    }, null, 2));
    const isolatedEnv = {
      ...process.env,
      HOME: path.join(temp, "home"),
      BUN_INSTALL_CACHE_DIR: path.join(temp, "bun-cache"),
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    };
    checked(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: sourceRepo,
      env: isolatedEnv,
      timeout: 120_000,
    }, "install source fixture dependencies with Bun");
    checked(process.execPath, ["run", "prepare"], {
      cwd: sourceRepo,
      env: isolatedEnv,
      timeout: 120_000,
    }, "prepare source fixture with Bun");
    checked(process.execPath, ["add", `file:${sourceRepo}`], {
      cwd: consumer,
      env: isolatedEnv,
      timeout: 120_000,
    }, "install local source dependency with Bun");

    const installed = path.join(consumer, "node_modules", "larkin");
    const cli = path.join(installed, "dist", "app", "cli.mjs");
    const transport = path.join(installed, "dist", "agent", "agent-transport.cjs");
    assert.equal(fs.existsSync(cli), true, "prepare must generate dist/app/cli.mjs");
    assert.equal(fs.existsSync(transport), true, "prepare must generate the CJS transport");
    assert.equal(fs.existsSync(path.join(installed, "test")), false, "installed Git dependency must exclude repository tests");
    const bin = process.platform === "win32"
      ? path.join(consumer, "node_modules", ".bin", "larkin.cmd")
      : path.join(consumer, "node_modules", ".bin", "larkin");
    const help = checked(bin, ["--help"], { cwd: consumer, env: isolatedEnv, timeout: 15_000 }, "run Git-installed package bin");
    assert.match(help.stdout, /Usage:\s*larkin <command>/);
    const importConfigDir = path.join(temp, "import-config");
    fs.mkdirSync(importConfigDir, { recursive: true });
    fs.writeFileSync(path.join(importConfigDir, "config.json"), `${JSON.stringify({
      version: 4,
      serverId: "git-dependency-test",
      mentionPolicy: "require",
      activeAgent: "cli_test",
      agents: { cli_test: { runtime: "pi", model: "default" } },
    }, null, 2)}\n`, { mode: 0o600 });
    const importedTransport = checked(process.execPath, ["--eval", `
      const transport = await import(${JSON.stringify(pathToFileURL(transport).href)});
      if (typeof transport.createAgentTransport !== "function") {
        throw new Error("installed transport does not export createAgentTransport");
      }
      process.stdout.write("createAgentTransport:function\\n");
    `], {
      cwd: consumer,
      env: { ...isolatedEnv, LARKIN_CONFIG_DIR: importConfigDir },
      timeout: 15_000,
    }, "dynamically import Git-installed CJS transport with Bun");
    assert.equal(importedTransport.stdout.trim(), "createAgentTransport:function");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
