#!/usr/bin/env bun
// 构建规则（避免手工三处清单漂移）：
//   1. Shell ESM：递归发现 src（dashboard/web 除外）的 authored source，按相同相对路径产出 .mjs（.cts 产出 .cjs）。
//   2. CJS：只有被 Agent transport / host / 测试真实消费的模块才产出 .cjs；
//      入口列在 CJS_ENTRYPOINTS，其余依赖按相对 import 自动做传递闭包，新增依赖不需要改这里。
//   3. 相对说明符统一机械改写：支持 ./ 与 ../ 多级路径；
//      显式 ./x.cjs 引用保持原样。
//   4. dashboard/web 由 Vite 独立编译为离线浏览器资产，并进入同一个原子发布 stage。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const optionValue = (name, fallback) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  if (!argv[index + 1]) {
    console.error(`[build] ${name} requires a path`);
    process.exit(1);
  }
  return argv[index + 1];
};
const SRC = path.resolve(optionValue("--src-dir", path.join(ROOT, "src")));
const OUT = path.resolve(optionValue("--out-dir", path.join(ROOT, "dist")));
const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
const vite = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
const dashboardWebRoot = path.join(SRC, "dashboard", "web");
const dashboardViteConfig = path.join(dashboardWebRoot, "vite.config.mjs");
const moduleSpecifierNodes = (file) => {
  const sourceFile = fs.readFileSync(file, "utf8");
  const scanner = createScanner(true, LanguageVariant.Standard, sourceFile);
  const tokens = [];
  const templateExpressionBraceDepth = [];
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.CloseBraceToken && templateExpressionBraceDepth.length
        && templateExpressionBraceDepth.at(-1) === 0) {
      // The scanner has no parser context, so it cannot know that this brace closes
      // a `${...}` interpolation. Resume template scanning explicitly; otherwise the
      // remaining file can be swallowed by one template token and later dynamic
      // imports never enter the dependency/rewrite graph.
      kind = scanner.reScanTemplateToken(false);
    }
    const start = scanner.getTokenStart();
    const end = scanner.getTokenEnd();
    // The standalone `#` in a regular expression (for example /^#/) is
    // reported as a zero-width PrivateIdentifier by the TS 7 scanner when
    // it is used without parser context. It cannot contain a module
    // specifier, so advance over it explicitly instead of looping forever.
    if (end <= start) {
      scanner.resetTokenState(start + 1);
      continue;
    }
    tokens.push({
      kind,
      text: kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral
        ? scanner.getTokenValue()
        : scanner.getTokenText(),
      start,
      end,
    });
    if (kind === SyntaxKind.TemplateHead) templateExpressionBraceDepth.push(0);
    else if (kind === SyntaxKind.TemplateTail) templateExpressionBraceDepth.pop();
    else if (kind === SyntaxKind.OpenBraceToken && templateExpressionBraceDepth.length) {
      templateExpressionBraceDepth[templateExpressionBraceDepth.length - 1] += 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templateExpressionBraceDepth.length) {
      templateExpressionBraceDepth[templateExpressionBraceDepth.length - 1] -= 1;
    }
  }
  const nodes = [];
  const isLiteral = (token) => token?.kind === SyntaxKind.StringLiteral
    || token?.kind === SyntaxKind.NoSubstitutionTemplateLiteral;
  const add = (token) => nodes.push({
    text: token.text,
    getEnd: () => token.end,
    getText: () => sourceFile.slice(token.start, token.end),
  });
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token.kind === SyntaxKind.RequireKeyword || token.text === "require")
        && tokens[index + 1]?.kind === SyntaxKind.OpenParenToken && isLiteral(tokens[index + 2])) {
      add(tokens[index + 2]);
      continue;
    }
    if (token.kind !== SyntaxKind.ImportKeyword && token.kind !== SyntaxKind.ExportKeyword) continue;
    if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken && isLiteral(tokens[index + 2])) {
      add(tokens[index + 2]);
      continue;
    }
    if (isLiteral(tokens[index + 1])) {
      add(tokens[index + 1]);
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].kind === SyntaxKind.SemicolonToken) break;
      if (tokens[cursor].kind === SyntaxKind.FromKeyword && isLiteral(tokens[cursor + 1])) {
        add(tokens[cursor + 1]);
        break;
      }
    }
  }
  return { sourceFile, nodes };
};

// CJS 真实入口：Agent transport、host frame 和测试直接 require 的模块。
const CJS_ENTRYPOINTS = [
  "platform/process-inspect.cts",
  "platform/root-layout.ts",
  "platform/config.ts",
  "feishu/message-policy.ts",
  "agent/agent-state-store.ts",
  "agent/reminder-store.ts",
  "agent/reminder-routes.ts",
  "agent/transport-shell.ts",
  "agent/transport-business-context.ts",
  "agent/agent-transport.ts",
  "feishu/host-shell.ts",
  "platform/workspace-service.ts",
];
const allSources = [];
const discoverSources = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && absolute !== dashboardWebRoot) discoverSources(absolute);
    else if (entry.isFile() && /\.(?:ts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      allSources.push(path.relative(SRC, absolute).split(path.sep).join("/"));
    }
  }
};
discoverSources(SRC);
allSources.sort((a, b) => a.localeCompare(b, "en"));
const moduleName = (file) => file.replace(/\.(?:ts|cts)$/, "");
const sourcePaths = allSources.map((name) => path.join(SRC, ...name.split("/")));

const byBasename = new Map();
for (const file of allSources) {
  const basename = path.basename(moduleName(file));
  const prior = byBasename.get(basename);
  if (prior) {
    console.error(`[build] basename 冲突: ${prior} / ${file}`);
    process.exit(1);
  }
  byBasename.set(basename, file);
}

const relativeImports = (file) => {
  const absolute = path.join(SRC, file);
  const specifiers = new Set();
  for (const node of moduleSpecifierNodes(absolute).nodes) {
    const match = /^(\.\.?\/.*)\.(js|cjs)$/.exec(node.text);
    if (!match) continue;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) {
      console.error(`[build] 相对 import 越界: ${file} -> ${match[1]}.${match[2]}`);
      process.exit(1);
    }
    const candidates = match[2] === "cjs" ? [`${base}.cts`, `${base}.ts`] : [`${base}.ts`];
    const target = candidates.find((candidate) => allSources.includes(candidate));
    if (!target) {
      console.error(`[build] 相对 import 缺失: ${file} -> ${match[1]}.${match[2]}`);
      process.exit(1);
    }
    specifiers.add(target);
  }
  return [...specifiers];
};
const cjsModules = new Set();
const queue = [...CJS_ENTRYPOINTS];
while (queue.length) {
  const file = queue.shift();
  if (cjsModules.has(file)) continue;
  console.error(`[build] graph scan ${file}`);
  if (!allSources.includes(file)) {
    console.error(`[build] CJS entrypoint/依赖不存在: ${file}`);
    process.exit(1);
  }
  cjsModules.add(file);
  queue.push(...relativeImports(file));
}
console.error(`[build] graph: ${allSources.length} shell sources, ${cjsModules.size} cjs modules`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-build-"));
const esmStage = path.join(stage, "esm");
const cjsStage = path.join(stage, "cjs");
const outputStage = path.join(path.dirname(OUT), `.${path.basename(OUT)}.${process.pid}.next`);

function compile(args) {
  const result = spawnSync(process.execPath, [tsc, "--ignoreConfig", ...args], { cwd: ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[build] tsc failed: ${result.error?.message || result.status}\n`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

const PI_SUBAGENTS_PACKAGE = "@tintinweb/pi-subagents";

// Bundle the pi-subagents extension into a single file that a pi runtime process
// can load via `--extension/-e`. The pi-* packages stay external because the
// extension always runs inside a pi process that provides them.
function bundlePiSubagentExtension(outFile) {
  const entry = path.join(ROOT, "node_modules", PI_SUBAGENTS_PACKAGE, "src", "index.ts");
  if (!fs.existsSync(entry)) {
    process.stderr.write(`[build] ${PI_SUBAGENTS_PACKAGE} not installed (expected ${entry})\n`);
    process.exitCode = 1;
    return false;
  }
  const result = spawnSync("bun", ["build", entry, "--outfile", outFile, "--external", "@earendil-works/pi-*", "--target", "bun"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[build] pi-subagents bundle failed: ${result.error?.message || result.status}\n`);
    process.exitCode = 1;
    return false;
  }
  process.stderr.write(result.stderr || result.stdout || "");
  console.error(`[build] pi-subagents bundle → ${path.relative(process.cwd(), outFile) || outFile}`);
  return true;
}

// Bundle the larkin-owned bash 60s timeout guard extension into a single file
// that a pi runtime process can load via `--extension/-e` (issue #55/#56).
// pi-* stays external because the extension always runs inside a pi process.
function bundlePiBashTimeoutExtension(outFile) {
  const entry = path.join(ROOT, "src", "runtime", "pi-bash-timeout-extension.ts");
  if (!fs.existsSync(entry)) {
    process.stderr.write(`[build] pi-bash-timeout extension entry missing: ${entry}\n`);
    process.exitCode = 1;
    return false;
  }
  const result = spawnSync("bun", ["build", entry, "--outfile", outFile, "--external", "@earendil-works/pi-*", "--target", "bun"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[build] pi-bash-timeout bundle failed: ${result.error?.message || result.status}\n`);
    process.exitCode = 1;
    return false;
  }
  process.stderr.write(result.stderr || result.stdout || "");
  console.error(`[build] pi-bash-timeout bundle → ${path.relative(process.cwd(), outFile) || outFile}`);
  return true;
}

function bundlePiSupervisedCommandExtension(outFile) {
  const entry = path.join(ROOT, "src", "runtime", "pi-supervised-command-extension.ts");
  if (!fs.existsSync(entry)) {
    process.stderr.write(`[build] pi-supervised-command extension entry missing: ${entry}\n`);
    process.exitCode = 1;
    return false;
  }
  const result = spawnSync("bun", ["build", entry, "--outfile", outFile, "--external", "@earendil-works/pi-*", "--target", "bun"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[build] pi-supervised-command bundle failed: ${result.error?.message || result.status}\n`);
    process.exitCode = 1;
    return false;
  }
  process.stderr.write(result.stderr || result.stdout || "");
  console.error(`[build] pi-supervised-command bundle → ${path.relative(process.cwd(), outFile) || outFile}`);
  return true;
}

function bundlePiSubagentRecordWatchdogExtension(outFile) {
  const entry = path.join(ROOT, "src", "runtime", "pi-subagent-record-watchdog.ts");
  if (!fs.existsSync(entry)) {
    process.stderr.write(`[build] pi-subagent-record-watchdog extension entry missing: ${entry}\n`);
    process.exitCode = 1;
    return false;
  }
  const result = spawnSync("bun", ["build", entry, "--outfile", outFile, "--external", "@earendil-works/pi-*", "--target", "bun"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[build] pi-subagent-record-watchdog bundle failed: ${result.error?.message || result.status}\n`);
    process.exitCode = 1;
    return false;
  }
  process.stderr.write(result.stderr || result.stdout || "");
  console.error(`[build] pi-subagent-record-watchdog bundle → ${path.relative(process.cwd(), outFile) || outFile}`);
  return true;
}

function buildDashboardWeb(outDir) {
  const viteEnv = { ...process.env, LARKIN_DASHBOARD_OUT_DIR: outDir, NODE_DISABLE_COMPILE_CACHE: "1" };
  delete viteEnv.NODE_COMPILE_CACHE;
  const result = spawnSync(process.execPath, [vite, "build", "--config", dashboardViteConfig], {
    cwd: ROOT,
    encoding: "utf8",
    env: viteEnv,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `[build] Vite failed: ${result.error?.message || result.status}\n`);
    process.exitCode = 1;
    return false;
  }
  process.stderr.write(result.stdout);
  return true;
}

class CompilationFailed extends Error {}

const rewriteSpecifiers = (file, code, extension) => {
  const { sourceFile, nodes } = moduleSpecifierNodes(file);
  const replacements = [];
  for (const node of nodes) {
    if (!/^\.\.?\//.test(node.text) || !node.text.endsWith(".js")) continue;
    const raw = node.getText(sourceFile);
    if (!raw.slice(1, -1).endsWith(".js")) continue;
    replacements.push({ start: node.getEnd() - 4, end: node.getEnd() - 1 });
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    code = `${code.slice(0, replacement.start)}.${extension}${code.slice(replacement.end)}`;
  }
  return code;
};

try {
  const common = ["--target", "es2022", "--strict", "--skipLibCheck", "--esModuleInterop", "--types", "node", "--rootDir", SRC];
  console.error("[build] compiling ESM");
  if (!compile([...common, "--module", "nodenext", "--moduleResolution", "nodenext", "--outDir", esmStage, ...sourcePaths])) throw new CompilationFailed();
  console.error("[build] compiling CJS");
  if (!compile([...common, "--module", "commonjs", "--outDir", cjsStage, ...[...cjsModules].map((name) => path.join(SRC, name))])) throw new CompilationFailed();

  console.error("[build] rewriting module specifiers");
  const outputs = new Map();
  for (const file of allSources) {
    const name = moduleName(file);
    if (file.endsWith(".cts")) {
      const emitted = path.join(esmStage, ...`${name}.cjs`.split("/"));
      outputs.set(`${name}.cjs`, rewriteSpecifiers(emitted, fs.readFileSync(emitted, "utf8"), "cjs"));
      continue;
    }
    const esm = path.join(esmStage, ...`${name}.js`.split("/"));
    outputs.set(`${name}.mjs`, rewriteSpecifiers(esm, fs.readFileSync(esm, "utf8"), "mjs"));
    if (cjsModules.has(file)) {
      const cjs = path.join(cjsStage, ...`${name}.js`.split("/"));
      outputs.set(`${name}.cjs`, rewriteSpecifiers(cjs, fs.readFileSync(cjs, "utf8"), "cjs"));
    }
  }
  fs.rmSync(outputStage, { recursive: true, force: true });
  fs.mkdirSync(outputStage, { recursive: true });
  for (const [name, data] of outputs) {
    const destination = path.join(outputStage, ...name.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { mode: ["app/cli.mjs", "app/lark-cli.mjs"].includes(name) ? 0o755 : 0o644 });
  }
  if (!buildDashboardWeb(path.join(outputStage, "dashboard", "web"))) throw new CompilationFailed();
  if (!bundlePiSubagentExtension(path.join(outputStage, "runtime", "pi-subagents.bundle.js"))) throw new CompilationFailed();
  if (!bundlePiBashTimeoutExtension(path.join(outputStage, "runtime", "pi-bash-timeout.bundle.js"))) throw new CompilationFailed();
  if (!bundlePiSubagentRecordWatchdogExtension(path.join(outputStage, "runtime", "pi-subagent-record-watchdog.bundle.js"))) throw new CompilationFailed();
  if (!bundlePiSupervisedCommandExtension(path.join(outputStage, "runtime", "pi-supervised-command.bundle.js"))) throw new CompilationFailed();

  // Materialize the whole graph before touching the active dist tree. Failed builds
  // preserve the prior output; successful builds replace it wholesale, removing stale files.
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const backup = path.join(path.dirname(OUT), `.${path.basename(OUT)}.${process.pid}.previous`);
  fs.rmSync(backup, { recursive: true, force: true });
  const hadOutput = fs.existsSync(OUT);
  try {
    if (hadOutput) fs.renameSync(OUT, backup);
    fs.renameSync(outputStage, OUT);
  } catch (error) {
    if (!fs.existsSync(OUT) && fs.existsSync(backup)) fs.renameSync(backup, OUT);
    throw error;
  }
  fs.rmSync(backup, { recursive: true, force: true });
  console.error(`[build] TypeScript + Vite → ${path.relative(process.cwd(), OUT) || "."} (${outputs.size} shell artifacts, ${allSources.length} shell sources, ${cjsModules.size} cjs)`);
} catch (error) {
  if (!(error instanceof CompilationFailed)) throw error;
} finally {
  fs.rmSync(outputStage, { recursive: true, force: true });
  fs.rmSync(stage, { recursive: true, force: true });
}
