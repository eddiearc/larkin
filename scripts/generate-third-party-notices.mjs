import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LARK_CLI_NATIVE_SHA256, LARK_CLI_VERSION, larkCliTarget } from "./release/lark-cli-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output");
const OUTPUT = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : "";
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const licenseName = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i;
const AUDITED_LICENSE_FALLBACKS = Object.freeze({
  "agent-base@6.0.2": { source: "agent-base", version: "9.0.0", file: "LICENSE", sha256: "8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a" },
  "https-proxy-agent@5.0.1": { source: "https-proxy-agent", version: "9.1.0", file: "LICENSE", sha256: "8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a" },
  "proxy-agent-negotiate@1.1.0": { source: "agent-base", version: "9.0.0", file: "LICENSE", sha256: "8d8c55319c7729d57be811c747452636688d54f19701ee0752b6b15ad3771d9a" },
  "react-remove-scroll-bar@2.3.8": { source: "react-remove-scroll", version: "2.7.2", file: "LICENSE", sha256: "30f0cfddf483d1128e3610205020f2041a6c5e837aa999e0aa82e5576187d4a9" },
});

function packageRoot(name, fromRoot = ROOT) {
  const local = path.join(fromRoot, "node_modules", ...name.split("/"));
  if (fs.existsSync(path.join(local, "package.json"))) return fs.realpathSync(local);
  const hoisted = path.join(ROOT, "node_modules", ...name.split("/"));
  if (fs.existsSync(path.join(hoisted, "package.json"))) return fs.realpathSync(hoisted);
  throw new Error(`runtime dependency is not installed: ${name}`);
}

function bundledLicenseFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => ({ name: entry.name, bytes: fs.readFileSync(path.join(root, entry.name)) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function auditedLicenseFallback(key) {
  const fallback = AUDITED_LICENSE_FALLBACKS[key];
  if (!fallback) throw new Error(`${key} has no bundled license text or audited exact fallback`);
  const sourceRoot = packageRoot(fallback.source);
  const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
  if (sourceManifest.version !== fallback.version) throw new Error(`${key} audited license source version changed`);
  if (!lockedIntegrities().has(`${fallback.source}@${fallback.version}`)) throw new Error(`${key} audited license source is not lock-integrity pinned`);
  const bytes = fs.readFileSync(path.join(sourceRoot, fallback.file));
  if (sha256(bytes) !== fallback.sha256 || !/Copyright \(c\) \d{4}/.test(bytes.toString("utf8"))) {
    throw new Error(`${key} audited license text provenance mismatch`);
  }
  return [{ name: `AUDITED-${fallback.source}@${fallback.version}-${fallback.file}`, bytes }];
}

function lockedIntegrities() {
  const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
  const entries = new Map();
  for (const match of lock.matchAll(/^    "[^"]+": \["((?:[^"\\]|\\.)+)".*?, "(sha512-[^"]+)"\],?$/gm)) {
    const spec = JSON.parse(`"${match[1]}"`);
    if (entries.has(spec) && entries.get(spec) !== match[2]) throw new Error(`conflicting lock integrity for ${spec}`);
    entries.set(spec, match[2]);
  }
  return entries;
}

function goCommand(args) {
  const result = spawnSync("go", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `go ${args.join(" ")} failed`);
  return result.stdout;
}

function embeddedGoModules() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "release", "lark-cli-go-modules.json"), "utf8"));
  if (lock.schemaVersion !== 1 || lock.larkCliVersion !== LARK_CLI_VERSION || !Array.isArray(lock.modules) || !lock.targetExclusions) {
    throw new Error("invalid embedded lark-cli Go module lock");
  }
  const binary = path.join(ROOT, "node_modules", "@larksuite", "cli", "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  const { key } = larkCliTarget(process.platform, process.arch);
  const actualBinaryHash = sha256(fs.readFileSync(binary));
  if (actualBinaryHash !== LARK_CLI_NATIVE_SHA256[key]) throw new Error("embedded lark-cli binary hash changed before Go module inspection");
  const actual = goCommand(["version", "-m", binary]).split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter(([kind]) => kind === "dep").map(([, module, version, sum]) => ({ module, version, sum }))
    .sort((left, right) => left.module.localeCompare(right.module));
  const targetKeys = Object.keys(lock.targetExclusions).sort();
  if (JSON.stringify(targetKeys) !== JSON.stringify(Object.keys(LARK_CLI_NATIVE_SHA256).sort())) {
    throw new Error("embedded lark-cli Go module lock does not cover every release target");
  }
  const exclusions = lock.targetExclusions[key];
  if (!Array.isArray(exclusions) || exclusions.some((module) => !lock.modules.some((entry) => entry.module === module))) {
    throw new Error(`invalid embedded Go module exclusions for ${key}`);
  }
  const expected = lock.modules.filter((entry) => !exclusions.includes(entry.module))
    .sort((left, right) => left.module.localeCompare(right.module));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("embedded lark-cli Go module set does not exactly match the fixed release closure");

  return [...lock.modules].sort((left, right) => left.module.localeCompare(right.module)).map((entry) => {
    const downloaded = JSON.parse(goCommand(["mod", "download", "-json", `${entry.module}@${entry.version}`]));
    if (downloaded.Path !== entry.module || downloaded.Version !== entry.version || downloaded.Sum !== entry.sum || !downloaded.Dir) {
      throw new Error(`Go module provenance mismatch for ${entry.module}@${entry.version}`);
    }
    const files = fs.readdirSync(downloaded.Dir, { withFileTypes: true })
      .filter((candidate) => candidate.isFile() && licenseName.test(candidate.name))
      .map((candidate) => ({ name: candidate.name, bytes: fs.readFileSync(path.join(downloaded.Dir, candidate.name)) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (files.length === 0) throw new Error(`Go module has no root license or notice text: ${entry.module}@${entry.version}`);
    return { ...entry, files };
  });
}

function runtimePackages() {
  const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const queue = Object.keys(rootManifest.dependencies ?? {}).map((name) => ({ name, fromRoot: ROOT, direct: true }));
  const seen = new Set();
  const integrities = lockedIntegrities();
  const packages = [];
  while (queue.length > 0) {
    const candidate = queue.shift();
    const root = packageRoot(candidate.name, candidate.fromRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const key = `${manifest.name}@${manifest.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const integrity = integrities.get(key);
    if (!integrity) throw new Error(`${key} is not pinned by bun.lock integrity`);
    let files = bundledLicenseFiles(root);
    const license = manifest.license ?? manifest.licenses ?? null;
    if (files.length === 0) {
      if (license !== "MIT") throw new Error(`${key} has no bundled license text and is not eligible for an MIT fallback`);
      files = auditedLicenseFallback(key);
    }
    packages.push({ name: manifest.name, version: manifest.version, license, files, direct: candidate.direct, integrity });

    // The CLI package contributes its separately downloaded, checksum-verified
    // native executable. Its JavaScript installer dependency is not distributed.
    if (manifest.name === "@larksuite/cli") continue;
    const children = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    };
    for (const name of Object.keys(children).sort()) {
      if (name.startsWith("@types/")) continue;
      try {
        packageRoot(name, root);
        queue.push({ name, fromRoot: root, direct: false });
      } catch {
        const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true;
        if (!optional) throw new Error(`runtime dependency is not installed: ${key} -> ${name}`);
      }
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function expression(value) {
  if (typeof value === "string") return value;
  if (value == null) return "(not declared)";
  return JSON.stringify(value);
}

const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

export function generateRuntimeNotices() {
  const packages = runtimePackages();
  const goModules = embeddedGoModules();
  const texts = new Map();
  const lines = [
    "Third-party notices", "", "Generated at release time from Larkin's installed runtime dependency closure.",
    "Development-only dependencies are intentionally excluded. Packages without a bundled license file",
    "use an explicitly audited, version- and hash-pinned license source and remain identified by locked package name and version.", "", `Runtime package versions: ${packages.length}`, "",
    "| Package | Version | Relationship | Declared license | License texts (SHA-256) | Lock integrity |",
    "| --- | ---: | --- | --- | --- | --- |",
  ];
  for (const pkg of packages) {
    const fileRefs = pkg.files.map(({ name, bytes }) => {
      const normalized = bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n")
        .map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\s*$/, "\n");
      const hash = sha256(Buffer.from(normalized));
      if (!texts.has(hash)) texts.set(hash, normalized);
      return `${name} (${hash})`;
    }).join("; ");
    if (!fileRefs) throw new Error(`${pkg.name}@${pkg.version} has no resolved license text`);
    lines.push(`| ${escapeCell(pkg.name)} | ${escapeCell(pkg.version)} | ${pkg.direct ? "runtime direct" : "runtime transitive"} | ${escapeCell(expression(pkg.license))} | ${fileRefs} | ${pkg.integrity} |`);
  }
  lines.push("", "Embedded lark-cli Go module license closure", "",
    `The ${goModules.length}-module release-family union below is fixed from go version -m metadata for all four pinned native binaries.`,
    "Each platform's exact module subset is bound by lark-cli-go-modules.json; the generator rejects any difference in the current binary.",
    "Each module source is fetched by fixed module@version and accepted only when its Go module sum matches the fixed metadata.", "",
    "| Go module | Version | Module sum | License/notice texts (SHA-256) |",
    "| --- | --- | --- | --- |");
  for (const module of goModules) {
    const fileRefs = module.files.map(({ name, bytes }) => {
      const normalized = bytes.toString("utf8").replace(/\r\n?/g, "\n").split("\n")
        .map((line) => line.replace(/[ \t]+$/, "")).join("\n").replace(/\s*$/, "\n");
      const hash = sha256(Buffer.from(normalized));
      if (!texts.has(hash)) texts.set(hash, normalized);
      return `${name} (${hash})`;
    }).join("; ");
    lines.push(`| ${escapeCell(module.module)} | ${module.version} | ${module.sum} | ${fileRefs} |`);
  }
  const cliPackage = packages.find((pkg) => pkg.name === "@larksuite/cli" && pkg.version === LARK_CLI_VERSION);
  if (!cliPackage) throw new Error(`embedded @larksuite/cli ${LARK_CLI_VERSION} is missing from the runtime closure`);
  const checksumsFile = path.join(ROOT, "node_modules", "@larksuite", "cli", "checksums.txt");
  const archiveChecksums = fs.readFileSync(checksumsFile, "utf8").split(/\r?\n/)
    .filter((line) => /lark-cli-1\.0\.78-(?:darwin|linux)-(?:amd64|arm64)\.tar\.gz$/.test(line));
  if (archiveChecksums.length !== 4) throw new Error("embedded lark-cli four-platform archive provenance is incomplete");
  lines.push("", "Embedded native component provenance", "", `@larksuite/cli ${LARK_CLI_VERSION} is distributed as a byte-identical native component.`,
    "Its package integrity is pinned by bun.lock; its upstream archive checksums and extracted native hashes are:", "",
    ...archiveChecksums.map((line) => `archive ${line}`),
    ...Object.entries(LARK_CLI_NATIVE_SHA256).sort(([left], [right]) => left.localeCompare(right)).map(([target, hash]) => `native ${hash}  ${target}`));
  const qr = packages.find((pkg) => pkg.name === "qrcode-terminal");
  if (!qr || !qr.files.some(({ bytes }) => /QRCode for JavaScript/.test(bytes.toString("utf8")) && /MIT license/i.test(bytes.toString("utf8")))) {
    throw new Error("qrcode-terminal bundled MIT attribution is missing from the runtime closure");
  }
  lines.push("", "Bundled license and notice texts", "");
  for (const [hash, text] of [...texts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`--- SHA-256 ${hash} ---`, text.replace(/\n$/, ""), "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

if (import.meta.main) {
  const generated = generateRuntimeNotices();
  const packageCount = [...generated.matchAll(/^\| [^|]+ \| [^ |]+ \| runtime /gm)].length;
  if (process.argv.includes("--check")) {
    if (OUTPUT) {
      const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
      if (current !== generated) throw new Error("runtime third-party notices do not byte-match regenerated output");
    }
    console.log(`runtime third-party notices validated for ${packageCount} package versions`);
  } else {
    if (!OUTPUT) throw new Error("--output is required when generating third-party notices");
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, generated);
    console.log(`wrote ${path.relative(ROOT, OUTPUT)}`);
  }
}
