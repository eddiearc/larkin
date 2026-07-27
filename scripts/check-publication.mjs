import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["README.md", "AGENTS.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md"];
const ALLOWED_MARKDOWN = new Set(["README.md", "AGENTS.md", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md"]);
const isAscii = (value) => /^[\x00-\x7f]*$/.test(value);

function parseArguments(argv) {
  let root = DEFAULT_ROOT;
  let treeOnly = false;
  let trusted = false;
  let denylistPath = process.env.LARKIN_PUBLICATION_DENYLIST_FILE || "";
  const artifacts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--tree-only") treeOnly = true;
    else if (value === "--trusted") trusted = true;
    else if (value === "--root") root = path.resolve(argv[++index] ?? "");
    else if (value === "--denylist") denylistPath = path.resolve(argv[++index] ?? "");
    else artifacts.push(path.resolve(value));
  }
  if (trusted && !denylistPath) throw new Error("trusted publication scan requires --denylist or LARKIN_PUBLICATION_DENYLIST_FILE");
  return { root, treeOnly, trusted, denylistPath, artifacts };
}

function loadDenylist(file) {
  if (!file) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length === 0) throw new Error("private publication denylist is empty");
  const entries = new Map();
  for (const line of lines) {
    const token = /^token:/i.test(line);
    const term = token ? line.slice("token:".length).trim() : line;
    if (!term) throw new Error("private publication denylist contains an empty token entry");
    const normalizedTerm = isAscii(term) ? term.toLocaleLowerCase("en-US") : term;
    entries.set(`${token}:${normalizedTerm}`, { term: normalizedTerm, token, ascii: isAscii(normalizedTerm) });
    if (token) continue;
    const parts = normalizedTerm.split(/[\s._/-]+/u).filter(Boolean);
    if (parts.length > 1) {
      for (const separator of ["", "-", ".", "_", " ", "/"]) {
        const variant = parts.join(separator);
        entries.set(`false:${variant}`, { term: variant, token: false, ascii: isAscii(variant) });
      }
    }
  }
  return [...entries.values()].sort((left, right) => right.term.length - left.term.length);
}

function git(root, args, encoding = null) {
  const result = spawnSync("git", args, { cwd: root, encoding, maxBuffer: 1024 * 1024 * 256 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `git ${args[0]} failed`);
  return result.stdout;
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

function matchesText(text, entry) {
  if (!entry.token) return text.includes(entry.term);
  let offset = text.indexOf(entry.term);
  while (offset >= 0) {
    const before = offset === 0 ? "" : [...text.slice(0, offset)].at(-1);
    const afterOffset = offset + entry.term.length;
    const after = afterOffset >= text.length ? "" : [...text.slice(afterOffset)][0];
    if ((!before || !ALPHANUMERIC.test(before)) && (!after || !ALPHANUMERIC.test(after))) return true;
    offset = text.indexOf(entry.term, offset + 1);
  }
  return false;
}

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

function encodedMatch(bytes, haystack, pattern, entry, encoding) {
  let offset = haystack.indexOf(pattern);
  while (offset >= 0) {
    if (!entry.token) return true;
    const end = offset + pattern.length;
    const before = encoding === "utf8" ? utf8Before(bytes, offset) : utf16Before(bytes, offset, encoding);
    const after = encoding === "utf8" ? utf8After(bytes, end) : utf16After(bytes, end, encoding);
    if ((!before || !ALPHANUMERIC.test(before)) && (!after || !ALPHANUMERIC.test(after))) return true;
    offset = haystack.indexOf(pattern, offset + 1);
  }
  return false;
}

function utf16be(value) {
  const encoded = Buffer.from(value, "utf16le");
  for (let index = 0; index < encoded.length; index += 2) [encoded[index], encoded[index + 1]] = [encoded[index + 1], encoded[index]];
  return encoded;
}

function decodeBomUtf16(bytes) {
  if (bytes.length < 2) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] !== 0xfe || bytes[1] !== 0xff) return null;
  const body = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
  for (let index = 0; index < body.length; index += 2) [body[index], body[index + 1]] = [body[index + 1], body[index]];
  return body.toString("utf16le");
}

function scanPrivateTerms(failures, label, bytes, deny) {
  if (deny.length === 0) return;

  // Fold only single-byte ASCII. This keeps byte offsets stable and lets native
  // Buffer searches replace four whole-artifact UTF-16 decodes.
  const folded = Buffer.from(bytes.toString("latin1").toLowerCase(), "latin1");
  for (const entry of deny) {
    const haystack = entry.ascii ? folded : bytes;
    if (encodedMatch(bytes, haystack, Buffer.from(entry.term, "utf8"), entry, "utf8")) {
      failures.push(`${label}: blocked by private publication denylist`);
      return;
    }
  }

  const bomText = decodeBomUtf16(bytes);
  if (bomText !== null) {
    const foldedText = bomText.toLocaleLowerCase("en-US");
    if (deny.some((entry) => matchesText(entry.ascii ? foldedText : bomText, entry))) {
      failures.push(`${label}: blocked by private publication denylist`);
      return;
    }
  }

  for (const entry of deny) {
    // Two-codepoint non-ASCII byte sequences collide frequently with opaque
    // native Unicode/locale tables. They remain covered as UTF-8 and as BOM-
    // marked UTF-16 text; BOM-less UTF-16 matching starts at three codepoints.
    if (!entry.ascii && [...entry.term].length < 3) continue;
    const haystack = entry.ascii ? folded : bytes;
    for (const [encoding, pattern] of [["le", Buffer.from(entry.term, "utf16le")], ["be", utf16be(entry.term)]]) {
      if (encodedMatch(bytes, haystack, pattern, entry, encoding)) {
        failures.push(`${label}: blocked by private publication denylist`);
        return;
      }
    }
  }
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
const notices = tracked.includes("THIRD_PARTY_NOTICES.md") ? indexBlob(options.root, "THIRD_PARTY_NOTICES.md").toString("utf8") : "";
if (!notices.includes("Generated by `bun run licenses:generate`")) failures.push("THIRD_PARTY_NOTICES.md: generated inventory marker missing");

let history = { refs: 0, objects: 0 };
if (!options.treeOnly) history = scanReachableHistory(options.root, failures, deny);
for (const artifact of options.artifacts) scanPrivateTerms(failures, `artifact ${artifact}`, fs.readFileSync(artifact), deny);

if (failures.length > 0) {
  console.error([...new Set(failures)].join("\n"));
  process.exit(1);
}
console.log(`publication check passed (mode=${options.treeOnly ? "tree" : "history"}, trusted=${options.trusted}, files=${tracked.length}, refs=${history.refs}, objects=${history.objects}, artifacts=${options.artifacts.length})`);
