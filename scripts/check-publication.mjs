import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LARK_CLI_NATIVE_SHA256, LARK_CLI_VERSION, larkCliTarget } from "./release/lark-cli-provenance.mjs";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["README.md", "AGENTS.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md"];
const ALLOWED_MARKDOWN = new Set(["README.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md"]);
const isAscii = (value) => /^[\x00-\x7f]*$/.test(value);

function parseArguments(argv) {
  let root = DEFAULT_ROOT;
  let treeOnly = false;
  let trusted = false;
  let denylistPath = process.env.LARKIN_PUBLICATION_DENYLIST_FILE || "";
  let embeddedLarkCliPath = "";
  const artifacts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--tree-only") treeOnly = true;
    else if (value === "--trusted") trusted = true;
    else if (value === "--root") root = path.resolve(argv[++index] ?? "");
    else if (value === "--denylist") denylistPath = path.resolve(argv[++index] ?? "");
    else if (value === "--allow-embedded-lark-cli") embeddedLarkCliPath = path.resolve(argv[++index] ?? "");
    else artifacts.push(path.resolve(value));
  }
  if (trusted && !denylistPath) throw new Error("trusted publication scan requires --denylist or LARKIN_PUBLICATION_DENYLIST_FILE");
  if (embeddedLarkCliPath && !trusted) throw new Error("embedded lark-cli provenance requires --trusted");
  return { root, treeOnly, trusted, denylistPath, embeddedLarkCliPath, artifacts };
}

function loadDenylist(file) {
  if (!file) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((value, index) => ({ value: value.trim(), line: index + 1 }))
    .filter(({ value }) => value && !value.startsWith("#"));
  if (lines.length === 0) throw new Error("private publication denylist is empty");
  const entries = new Map();
  for (const { value, line } of lines) {
    const token = /^token:/i.test(value);
    const term = token ? value.slice("token:".length).trim() : value;
    if (!term) throw new Error("private publication denylist contains an empty token entry");
    const normalizedTerm = isAscii(term) ? term.toLocaleLowerCase("en-US") : term;
    const add = (variant, variantToken) => {
      const key = `${variantToken}:${variant}`;
      if (!entries.has(key)) entries.set(key, { term: variant, token: variantToken, ascii: isAscii(variant), line });
    };
    add(normalizedTerm, token);
    if (token) continue;
    const parts = normalizedTerm.split(/[\s._/-]+/u).filter(Boolean);
    if (parts.length > 1) {
      for (const separator of ["", "-", ".", "_", " ", "/"]) {
        const variant = parts.join(separator);
        add(variant, false);
      }
    }
  }
  return [...entries.values()].sort((left, right) => right.term.length - left.term.length || left.line - right.line);
}

function git(root, args, encoding = null) {
  const result = spawnSync("git", args, { cwd: root, encoding, maxBuffer: 1024 * 1024 * 256 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `git ${args[0]} failed`);
  return result.stdout;
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

function utf8Before(bytes, offset) {
  if (offset === 0) return "";
  let start = offset - 1;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  return [...bytes.subarray(start, offset).toString("utf8")].at(-1) ?? "";
}

function utf8After(bytes, offset) {
  if (offset >= bytes.length) return "";
  const first = bytes[offset];
  const length = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  return [...bytes.subarray(offset, Math.min(bytes.length, offset + length)).toString("utf8")][0] ?? "";
}

function readUtf16Unit(bytes, offset, endian) {
  if (offset < 0 || offset + 2 > bytes.length) return null;
  return endian === "le" ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
}

function utf16Before(bytes, offset, endian) {
  const last = readUtf16Unit(bytes, offset - 2, endian);
  if (last === null) return "";
  if (last >= 0xdc00 && last <= 0xdfff) {
    const first = readUtf16Unit(bytes, offset - 4, endian);
    if (first !== null && first >= 0xd800 && first <= 0xdbff) return String.fromCodePoint(((first - 0xd800) << 10) + last - 0xdc00 + 0x10000);
  }
  return String.fromCharCode(last);
}

function utf16After(bytes, offset, endian) {
  const first = readUtf16Unit(bytes, offset, endian);
  if (first === null) return "";
  if (first >= 0xd800 && first <= 0xdbff) {
    const last = readUtf16Unit(bytes, offset + 2, endian);
    if (last !== null && last >= 0xdc00 && last <= 0xdfff) return String.fromCodePoint(((first - 0xd800) << 10) + last - 0xdc00 + 0x10000);
  }
  return String.fromCharCode(first);
}

function encodedMatch(bytes, haystack, pattern, entry, encoding, ignoredRanges) {
  let offset = haystack.indexOf(pattern);
  while (offset >= 0) {
    const end = offset + pattern.length;
    const boundaryMatch = !entry.token || (() => {
      const before = encoding === "utf8" ? utf8Before(bytes, offset) : utf16Before(bytes, offset, encoding);
      const after = encoding === "utf8" ? utf8After(bytes, end) : utf16After(bytes, end, encoding);
      return (!before || !ALPHANUMERIC.test(before)) && (!after || !ALPHANUMERIC.test(after));
    })();
    if (boundaryMatch && !ignoredRanges.some((range) => offset >= range.start && end <= range.end)) return { start: offset, end };
    offset = haystack.indexOf(pattern, offset + 1);
  }
  return null;
}

function utf16be(value) {
  const encoded = Buffer.from(value, "utf16le");
  for (let index = 0; index < encoded.length; index += 2) [encoded[index], encoded[index + 1]] = [encoded[index + 1], encoded[index]];
  return encoded;
}

function scanPrivateTerms(failures, label, bytes, deny, source = "larkin", ignoredRanges = []) {
  if (deny.length === 0) return;

  // Fold only single-byte ASCII. This keeps byte offsets stable and lets native
  // Buffer searches replace four whole-artifact UTF-16 decodes.
  const folded = Buffer.from(bytes.toString("latin1").toLowerCase(), "latin1");
  for (const [entryIndex, entry] of deny.entries()) {
    const haystack = entry.ascii ? folded : bytes;
    if (encodedMatch(bytes, haystack, Buffer.from(entry.term, "utf8"), entry, "utf8", ignoredRanges)) {
      failures.push(`${label}: blocked by private publication denylist (source=${source}; line=${entry.line}; encoding=utf8)`);
      return;
    }
  }

  for (const entry of deny) {
    // Two-codepoint non-ASCII byte sequences collide frequently with opaque
    // native Unicode/locale tables. They remain covered as UTF-8 and as BOM-
    // marked UTF-16 text; BOM-less UTF-16 matching starts at three codepoints.
    const haystack = entry.ascii ? folded : bytes;
    for (const [encoding, pattern] of [["le", Buffer.from(entry.term, "utf16le")], ["be", utf16be(entry.term)]]) {
      if (!entry.ascii && [...entry.term].length < 3) {
        const bom = encoding === "le" ? bytes[0] === 0xff && bytes[1] === 0xfe : bytes[0] === 0xfe && bytes[1] === 0xff;
        if (!bom) continue;
      }
      if (encodedMatch(bytes, haystack, pattern, entry, encoding, ignoredRanges)) {
        failures.push(`${label}: blocked by private publication denylist (source=${source}; line=${entry.line}; encoding=utf16-${encoding})`);
        return;
      }
    }
  }
}

function verifiedEmbeddedLarkCli(root, file) {
  if (!file) return null;
  const packageRoot = path.join(root, "node_modules", "@larksuite", "cli");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.name !== "@larksuite/cli" || manifest.version !== LARK_CLI_VERSION) {
    throw new Error(`embedded lark-cli provenance requires @larksuite/cli ${LARK_CLI_VERSION}`);
  }
  const lock = fs.readFileSync(path.join(root, "bun.lock"), "utf8");
  if (!/"@larksuite\/cli": \["@larksuite\/cli@1\.0\.78",[^\n]+"sha512-[A-Za-z0-9+/=]+"\]/.test(lock)) {
    throw new Error("embedded lark-cli provenance is not pinned by bun.lock integrity");
  }
  const checksums = fs.readFileSync(path.join(packageRoot, "checksums.txt"), "utf8");
  const { key, archive } = larkCliTarget(process.platform, process.arch);
  if (!new RegExp(`^[a-f0-9]{64}  ${archive.replaceAll(".", "\\.")}$`, "m").test(checksums)) {
    throw new Error("embedded lark-cli archive checksum provenance is unavailable");
  }
  const expected = path.join(packageRoot, "bin", process.platform === "win32" ? "lark-cli.exe" : "lark-cli");
  if (path.resolve(file) !== path.resolve(expected) || !fs.statSync(file).isFile()) {
    throw new Error("embedded lark-cli path is outside the pinned package");
  }
  const bytes = fs.readFileSync(file);
  const expectedHash = LARK_CLI_NATIVE_SHA256[key];
  const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!expectedHash || actualHash !== expectedHash) throw new Error("embedded lark-cli binary does not match the pinned platform hash");
  return bytes;
}

function scanArtifact(failures, artifact, bytes, deny, embedded) {
  const label = `artifact ${artifact}`;
  if (!embedded || !/^larkin-v/.test(path.basename(artifact))) return scanPrivateTerms(failures, label, bytes, deny, "artifact");
  const offsets = [];
  let offset = bytes.indexOf(embedded);
  while (offset >= 0) {
    offsets.push(offset);
    offset = bytes.indexOf(embedded, offset + embedded.length);
  }
  if (offsets.length !== 1) {
    failures.push(`${label}: expected exactly one byte-identical pinned @larksuite/cli component, found ${offsets.length}`);
    return;
  }
  const start = offsets[0];
  scanPrivateTerms(failures, label, bytes, deny, "artifact-larkin", [{ start, end: start + embedded.length }]);
}

function scanProsePointers(failures, label, bytes) {
  if (!/\.(?:md|mdx)$/i.test(label)) return;
  const text = bytes.toString("utf8");
  if (/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(text)) failures.push(`${label}: historical pull-request link`);
  if (/\b(?:commit|revision)\s+`?[0-9a-f]{7,40}\b/i.test(text) || /`[0-9a-f]{7,40}`/.test(text)) {
    failures.push(`${label}: historical commit pointer`);
  }
  if (/`(?:codex|feature|fix)\/[a-z0-9._/-]+`/i.test(text)) failures.push(`${label}: historical branch pointer`);
}

const indexFiles = (root) => git(root, ["ls-files", "-z", "--cached"], "utf8").split("\0").filter(Boolean);
const indexBlob = (root, relative) => git(root, ["show", `:${relative}`]);

function scanIndex(root, failures, deny) {
  const tracked = indexFiles(root);
  for (const relative of tracked) {
    const normalized = relative.replaceAll(path.sep, "/");
    const bytes = indexBlob(root, relative);
    scanPrivateTerms(failures, `index path ${normalized}`, Buffer.from(normalized), deny);
    scanPrivateTerms(failures, `index blob ${normalized}`, bytes, deny);
    scanProsePointers(failures, normalized, bytes);
    if (normalized.startsWith("docs/") || normalized.startsWith(".claude/")) {
      failures.push(`${normalized}: internal documentation path is not allowed`);
    }
    if (/\.(?:md|mdx|markdown)$/i.test(normalized) && !ALLOWED_MARKDOWN.has(normalized)) {
      failures.push(`${normalized}: Markdown file is outside the publication allowlist`);
    }
  }
  return tracked;
}

function scanReachableHistory(root, failures, deny) {
  const refs = git(root, ["for-each-ref", "--format=%(refname)"], "utf8").split("\n").filter(Boolean);
  for (const ref of refs) scanPrivateTerms(failures, `ref ${ref}`, Buffer.from(ref), deny);
  const seen = new Set();
  const tagRefs = git(root, ["for-each-ref", "refs/tags", "--format=%(objecttype) %(objectname) %(refname)"], "utf8").split("\n").filter(Boolean);
  for (const line of tagRefs) {
    const [type, object, ref] = line.split(" ", 3);
    if (type !== "tag") continue;
    scanPrivateTerms(failures, `annotated tag ${ref}`, git(root, ["cat-file", "-p", object]), deny);
    seen.add(object);
  }
  const objects = git(root, ["rev-list", "--objects", "--all"], "utf8").split("\n").filter(Boolean);
  for (const line of objects) {
    const separator = line.indexOf(" ");
    const object = separator < 0 ? line : line.slice(0, separator);
    const objectPath = separator < 0 ? "" : line.slice(separator + 1);
    if (objectPath) scanPrivateTerms(failures, `history path ${objectPath}`, Buffer.from(objectPath), deny);
    if (seen.has(object)) continue;
    seen.add(object);
    const type = git(root, ["cat-file", "-t", object], "utf8").trim();
    if (type !== "tree") scanPrivateTerms(failures, `history ${type} ${object}`, git(root, ["cat-file", "-p", object]), deny);
  }
  return { refs: refs.length, objects: seen.size };
}

const options = parseArguments(process.argv.slice(2));
const deny = loadDenylist(options.denylistPath);
const embeddedLarkCli = verifiedEmbeddedLarkCli(options.root, options.embeddedLarkCliPath);
const failures = [];
const tracked = scanIndex(options.root, failures, deny);
for (const required of REQUIRED) {
  if (!tracked.includes(required)) failures.push(`${required}: required publication file is not tracked in the Git index`);
}

let packageJson = {};
try {
  packageJson = JSON.parse(indexBlob(options.root, "package.json").toString("utf8"));
} catch (error) {
  failures.push(`package.json: invalid tracked metadata (${error.message})`);
}
if (packageJson.license !== "Apache-2.0") failures.push("package.json: license must be Apache-2.0");
if (packageJson.private !== true) failures.push("package.json: private must prevent accidental registry publication");
const license = tracked.includes("LICENSE") ? indexBlob(options.root, "LICENSE").toString("utf8") : "";
if (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) failures.push("LICENSE: canonical Apache-2.0 text is required");
let history = { refs: 0, objects: 0 };
if (!options.treeOnly) history = scanReachableHistory(options.root, failures, deny);
for (const artifact of options.artifacts) scanArtifact(failures, artifact, fs.readFileSync(artifact), deny, embeddedLarkCli);

if (failures.length > 0) {
  console.error([...new Set(failures)].join("\n"));
  process.exit(1);
}
console.log(`publication check passed (mode=${options.treeOnly ? "tree" : "history"}, trusted=${options.trusted}, files=${tracked.length}, refs=${history.refs}, objects=${history.objects}, artifacts=${options.artifacts.length})`);
