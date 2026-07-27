import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputIndex = process.argv.indexOf("--output");
const OUTPUT = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : path.join(ROOT, "THIRD_PARTY_NOTICES.md");
const CACHE = path.join(ROOT, "node_modules", ".cache", "larkin-license-inventory");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const licenseName = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i;

function splitSpec(spec) {
  const separator = spec.lastIndexOf("@");
  if (separator <= 0) throw new Error(`unsupported locked package spec: ${spec}`);
  return { name: spec.slice(0, separator), version: spec.slice(separator + 1) };
}

function lockedPackages() {
  const lock = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
  const specs = new Map();
  for (const match of lock.matchAll(/^    "[^"]+": \["((?:[^"\\]|\\.)+)".*?, "(sha512-[^"]+)"\],?$/gm)) {
    const spec = JSON.parse(`"${match[1]}"`);
    if (specs.has(spec) && specs.get(spec) !== match[2]) throw new Error(`conflicting integrity for ${spec}`);
    specs.set(spec, match[2]);
  }
  return [...specs].map(([spec, integrity]) => ({ ...splitSpec(spec), integrity }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

function packageRoots(nodeModules) {
  const roots = [];
  if (!fs.existsSync(nodeModules)) return roots;
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const absolute = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const child of fs.readdirSync(absolute, { withFileTypes: true })) if (child.isDirectory()) roots.push(path.join(absolute, child.name));
    } else roots.push(absolute);
  }
  return roots;
}

function bundledLicenseFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && licenseName.test(entry.name))
    .map((entry) => ({ name: entry.name, bytes: fs.readFileSync(path.join(root, entry.name)) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function installedPackages() {
  const queue = packageRoots(path.join(ROOT, "node_modules"));
  const seenRoots = new Set();
  const packages = new Map();
  while (queue.length > 0) {
    const packageRoot = queue.shift();
    const realRoot = fs.realpathSync(packageRoot);
    if (seenRoots.has(realRoot)) continue;
    seenRoots.add(realRoot);
    const manifestPath = path.join(realRoot, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name && manifest.version) {
      packages.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? manifest.licenses ?? null,
        files: bundledLicenseFiles(realRoot),
      });
    }
    queue.push(...packageRoots(path.join(realRoot, "node_modules")));
  }
  return packages;
}

async function registryPackage(name, version, expectedIntegrity) {
  fs.mkdirSync(CACHE, { recursive: true });
  const cacheKey = sha256(Buffer.from(expectedIntegrity));
  const metadataFile = path.join(CACHE, `${cacheKey}.json`);
  const tarballFile = path.join(CACHE, `${cacheKey}.tgz`);
  let metadata;
  let bytes;
  if (fs.existsSync(metadataFile) && fs.existsSync(tarballFile)) {
    metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
    bytes = fs.readFileSync(tarballFile);
  } else {
    const metadataUrl = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
    const metadataResponse = await fetch(metadataUrl);
    if (!metadataResponse.ok) throw new Error(`registry metadata failed for ${name}@${version}: ${metadataResponse.status}`);
    metadata = await metadataResponse.json();
    const tarballResponse = await fetch(metadata.dist.tarball);
    if (!tarballResponse.ok) throw new Error(`registry tarball failed for ${name}@${version}: ${tarballResponse.status}`);
    bytes = Buffer.from(await tarballResponse.arrayBuffer());
    fs.writeFileSync(metadataFile, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    fs.writeFileSync(tarballFile, bytes, { mode: 0o600 });
  }
  const actualIntegrity = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
  if (metadata.dist.integrity !== expectedIntegrity || actualIntegrity !== expectedIntegrity) {
    throw new Error(`registry integrity mismatch for ${name}@${version}`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-license-package-"));
  const archive = path.join(temporary, "package.tgz");
  try {
    fs.writeFileSync(archive, bytes);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error(listing.stderr || `cannot list ${name}@${version}`);
    const entries = listing.stdout.split("\n").filter((entry) => /^package\/[^/]+$/.test(entry) && licenseName.test(path.basename(entry))).sort();
    const files = entries.map((entry) => {
      const extracted = spawnSync("tar", ["-xOzf", archive, entry], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
      if (extracted.status !== 0) throw new Error(extracted.stderr?.toString() || `cannot extract ${entry}`);
      return { name: path.basename(entry), bytes: extracted.stdout };
    });
    return { name, version, license: metadata.license ?? metadata.licenses ?? null, files };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function expression(value) {
  if (typeof value === "string") return value;
  if (value == null) return "(not declared)";
  return JSON.stringify(value);
}

const escapeCell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");

async function generate() {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const installed = installedPackages();
  const directKeys = (names) => new Set(names.map((name) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8"));
    return `${name}@${manifest.version}`;
  }));
  const runtimeDirect = directKeys(Object.keys(rootPackage.dependencies ?? {}));
  const developmentDirect = directKeys(Object.keys(rootPackage.devDependencies ?? {}));
  const packages = [];
  for (const locked of lockedPackages()) {
    const key = `${locked.name}@${locked.version}`;
    const pkg = installed.get(key) ?? await registryPackage(locked.name, locked.version, locked.integrity);
    if (pkg.license == null && pkg.files.length === 0) throw new Error(`${key} has neither license metadata nor a bundled license file`);
    packages.push(pkg);
  }
  const texts = new Map();
  const lines = [
    "# Third-party notices", "",
    "> Generated by `bun run licenses:generate` from every resolved package version in `bun.lock`.",
    "> Do not edit by hand; run `bun run licenses:check` to verify lock coverage and license-text integrity.", "",
    "Larkin itself is licensed under Apache-2.0. Every locked dependency is listed below, including transitive,",
    "bundled and platform-specific packages. License-file texts are deduplicated by SHA-256 and reproduced", "after the inventory.", "",
    `Locked package versions: **${packages.length}**`, "",
    "| Package | Version | Relationship | Declared license | Bundled license files (SHA-256) |",
    "| --- | ---: | --- | --- | --- |",
  ];
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    const relationship = runtimeDirect.has(key) ? "runtime direct" : developmentDirect.has(key) ? "development direct" : "transitive";
    const fileRefs = pkg.files.map(({ name, bytes }) => {
      const normalized = bytes.toString("utf8")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\s*$/, "\n");
      const hash = sha256(Buffer.from(normalized));
      if (!texts.has(hash)) texts.set(hash, normalized);
      return `\`${name}\` \`${hash}\``;
    }).join("<br>") || "(none bundled)";
    lines.push(`| \`${escapeCell(pkg.name)}\` | ${escapeCell(pkg.version)} | ${relationship} | ${escapeCell(expression(pkg.license))} | ${fileRefs} |`);
  }
  const qr = packages.find((pkg) => pkg.name === "qrcode-terminal");
  if (!qr || !qr.files.some(({ bytes }) => /QRCode for JavaScript/.test(bytes.toString("utf8")) && /MIT license/i.test(bytes.toString("utf8")))) {
    throw new Error("qrcode-terminal bundled MIT attribution is missing from the resolved license file");
  }
  lines.push("", "## Bundled license and notice texts", "");
  for (const [hash, text] of [...texts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### SHA-256 \`${hash}\``, "", "```text", text.replace(/```/g, "` ` `").replace(/\n$/, ""), "```", "");
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

async function check() {
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";
  const generated = await generate();
  if (current !== generated) throw new Error("THIRD_PARTY_NOTICES.md does not byte-match the complete regenerated inventory");
  const packages = [...generated.matchAll(/^\| `([^`]+)` \| ([^ |]+) \|/gm)].length;
  const texts = [...generated.matchAll(/^### SHA-256 `[0-9a-f]{64}`$/gm)].length;
  console.log(`third-party notices byte-match ${packages} locked package versions and ${texts} license texts`);
}

if (process.argv.includes("--check")) await check();
else {
  fs.writeFileSync(OUTPUT, await generate());
  console.log(`wrote ${path.relative(ROOT, OUTPUT)}`);
}
