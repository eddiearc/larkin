import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHECK = path.join(ROOT, "scripts/check-publication.mjs");
const denyTerm = "fixture sensitive marker";
const marker = "fixture-sensitive-marker";

function command(cwd, executable, args) {
  return spawnSync(executable, args, { cwd, encoding: "utf8" });
}

function git(cwd, ...args) {
  const result = command(cwd, "git", args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-publication-fixture-"));
  fs.writeFileSync(path.join(root, "README.md"), "# Larkin\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Contributor Guide\n");
  fs.writeFileSync(path.join(root, "LICENSE"), "Apache License\nVersion 2.0, January 2004\n");
  fs.writeFileSync(path.join(root, "SECURITY.md"), "# Security\n");
  fs.writeFileSync(path.join(root, "CONTRIBUTING.md"), "# Contributing\n");
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ private: true, license: "Apache-2.0" }, null, 2)}\n`);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Publication Test");
  git(root, "config", "user.email", "publication-test@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial public source");
  return root;
}

function runCheck(root, ...args) {
  const denylist = path.join(root, "private-denylist.txt");
  fs.writeFileSync(denylist, `${denyTerm}\n`, { mode: 0o600 });
  return command(root, process.execPath, [CHECK, "--root", root, "--denylist", denylist, ...args]);
}

function runCheckWithTerms(root, terms, ...args) {
  const denylist = path.join(root, "private-token-denylist.txt");
  fs.writeFileSync(denylist, `${terms.join("\n")}\n`, { mode: 0o600 });
  return command(root, process.execPath, [CHECK, "--root", root, "--denylist", denylist, ...args]);
}

test("indexed source satisfies the public tree preparation boundary", () => {
  const result = command(ROOT, process.execPath, [CHECK, "--tree-only"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /mode=tree/);
}, 20_000);

test("runtime-only dependency notices are deterministic and exclude development packages", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-notices-"));
  const output = path.join(temp, "THIRD_PARTY_NOTICES.txt");
  try {
    const generate = command(ROOT, process.execPath, [path.join(ROOT, "scripts/generate-third-party-notices.mjs"), "--output", output]);
    assert.equal(generate.status, 0, generate.stderr || generate.stdout);
    const notices = fs.readFileSync(output, "utf8");
    assert.doesNotMatch(notices, /@larksuite\/cli|Embedded lark-cli|Embedded native component/);
    assert.match(notices, /\| qrcode-terminal \| 0\.12\.0 \| runtime direct \| \[\{"type":"Apache 2\.0"\}\] \|/);
    for (const developmentOnly of ["vitest", "typescript", "@testing-library/react", "tailwindcss"]) {
      assert.doesNotMatch(notices, new RegExp(`\\| ${developmentOnly.replace("/", "\\/")} \\|`));
    }
    assert.doesNotMatch(notices, /\(none bundled\)/);
    assert.match(notices, /agent-base \| 6\.0\.2[\s\S]*AUDITED-agent-base@9\.0\.0-LICENSE/);
    assert.doesNotMatch(notices, /<year>|<copyright holders>/);
    const result = command(ROOT, process.execPath, [path.join(ROOT, "scripts/generate-third-party-notices.mjs"), "--check", "--output", output]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 120_000);

test("trusted scans fail closed without a private denylist", () => {
  const root = fixture();
  try {
    const result = command(root, process.execPath, [CHECK, "--root", root, "--tree-only", "--trusted"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /trusted publication scan requires/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public scanner contains no private marker fingerprints or embedded CLI exceptions", () => {
  const source = fs.readFileSync(CHECK, "utf8");
  assert.equal(source.match(/\b[0-9a-f]{64}\b/gi)?.length ?? 0, 0);
  assert.doesNotMatch(source, /allow-embedded-lark-cli|LARK_CLI_NATIVE_SHA256/);
  assert.doesNotMatch(source, /extra-deny|markerDigest|const DENY\b/);
});

test("trusted diagnostics identify only entry ordinal, encoding, and source", () => {
  const root = fixture();
  const artifact = path.join(root, "diagnostic-artifact.bin");
  const privateValue = ["diagnostic", "private", "value"].join("-");
  try {
    fs.writeFileSync(artifact, privateValue);
    const result = runCheckWithTerms(root, [privateValue], "--tree-only", artifact);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source=artifact; line=1; encoding=utf8/);
    assert.equal(result.stderr.includes(privateValue), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trusted diagnostics retain the original denylist line through variants and sorting", () => {
  const root = fixture();
  const artifact = path.join(root, "line-artifact.bin");
  const denylist = path.join(root, "line-denylist.txt");
  const marker = ["stable", "source", "marker"].join("-");
  try {
    fs.writeFileSync(artifact, marker);
    fs.writeFileSync(denylist, `# comment\nshort\n\nstable source marker\n`, { mode: 0o600 });
    const result = command(root, process.execPath, [CHECK, "--root", root, "--tree-only", "--denylist", denylist, artifact]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source=artifact; line=4; encoding=utf8/);
    assert.equal(result.stderr.includes(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trusted scan applies the private denylist to generated runtime notices", () => {
  const root = fixture();
  const artifact = path.join(root, "THIRD_PARTY_NOTICES.txt");
  const privateValue = ["private", "notice", "marker"].join("-");
  try {
    fs.writeFileSync(artifact, `runtime notices ${privateValue}\n`);
    const result = runCheckWithTerms(root, [privateValue], "--tree-only", artifact);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /THIRD_PARTY_NOTICES\.txt: blocked by private publication denylist/);
    assert.match(result.stderr, /source=artifact; line=1; encoding=utf8/);
    assert.equal(result.stderr.includes(privateValue), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private token mode respects word boundaries and derived path separators", () => {
  const root = fixture();
  const artifact = path.join(root, "token-artifact.bin");
  const token = "fixturekey";
  try {
    fs.writeFileSync(artifact, `prefix${token}suffix`);
    const largerWord = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
    assert.equal(largerWord.status, 0, largerWord.stderr || largerWord.stdout);

    for (const value of [token, `${token}-addon`, `${token}.addon`, `/private/${token}/path`]) {
      fs.writeFileSync(artifact, value);
      const blocked = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
      assert.equal(blocked.status, 1, blocked.stdout);
      assert.match(blocked.stderr, /blocked by private publication denylist/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("binary scan preserves NUL boundaries while decoding UTF-16 at either byte alignment", () => {
  const root = fixture();
  const artifact = path.join(root, "aligned-artifact.bin");
  const token = "alignedfixture";
  try {
    const separated = Buffer.concat([
      Buffer.from([0xa5, 0x5a]),
      Buffer.from("aligned"),
      Buffer.from([0]),
      Buffer.from("fixture"),
      Buffer.from([0x5a, 0xa5]),
    ]);
    fs.writeFileSync(artifact, separated);
    const clean = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);

    for (const prefix of [Buffer.from([0]), Buffer.from([0, 0])]) {
      fs.writeFileSync(artifact, Buffer.concat([prefix, Buffer.from(token), Buffer.from([0])]));
      const blocked = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
      assert.equal(blocked.status, 1, blocked.stdout);
      assert.match(blocked.stderr, /blocked by private publication denylist/);
    }

    const utf16le = Buffer.from(token, "utf16le");
    const utf16be = Buffer.from(utf16le);
    for (let index = 0; index < utf16be.length; index += 2) [utf16be[index], utf16be[index + 1]] = [utf16be[index + 1], utf16be[index]];
    const encoded = [
      Buffer.concat([utf16le, Buffer.from([0, 0])]),
      Buffer.concat([Buffer.from([0xff]), utf16le, Buffer.from([0, 0])]),
      Buffer.concat([utf16be, Buffer.from([0, 0])]),
      Buffer.concat([Buffer.from([0xff]), utf16be, Buffer.from([0, 0])]),
    ];
    for (const bytes of encoded) {
      fs.writeFileSync(artifact, bytes);
      const blocked = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
      assert.equal(blocked.status, 1, blocked.stdout);
      assert.match(blocked.stderr, /blocked by private publication denylist/);
    }

    for (const bytes of [
      Buffer.concat([Buffer.from([0xff, 0xfe, 0xff]), utf16le]),
      Buffer.concat([Buffer.from([0xfe, 0xff, 0xfe]), utf16be]),
    ]) {
      fs.writeFileSync(artifact, bytes);
      const blocked = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
      assert.equal(blocked.status, 1, "a BOM must not bypass an odd-aligned raw UTF-16 marker");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("denylist case policy is insensitive for ASCII and exact for terms containing non-ASCII", () => {
  const root = fixture();
  const artifact = path.join(root, "case-policy-artifact.bin");
  const exact = "\u00c9xZ";
  const differentCase = "\u00e9xz";
  try {
    fs.writeFileSync(artifact, "AsCiIfIxTuRe");
    assert.equal(runCheckWithTerms(root, ["asciifixture"], "--tree-only", artifact).status, 1, "ASCII matching must remain case-insensitive");

    fs.writeFileSync(artifact, Buffer.from(exact, "utf8"));
    assert.equal(runCheckWithTerms(root, [exact], "--tree-only", artifact).status, 1, "exact UTF-8 non-ASCII term must be rejected");
    fs.writeFileSync(artifact, Buffer.from(differentCase, "utf8"));
    assert.equal(runCheckWithTerms(root, [exact], "--tree-only", artifact).status, 0, "UTF-8 non-ASCII matching must preserve exact case");

    fs.writeFileSync(artifact, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(exact, "utf16le")]));
    assert.equal(runCheckWithTerms(root, [exact], "--tree-only", artifact).status, 1, "exact BOM UTF-16 non-ASCII term must be rejected");
    fs.writeFileSync(artifact, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(differentCase, "utf16le")]));
    assert.equal(runCheckWithTerms(root, [exact], "--tree-only", artifact).status, 0, "BOM UTF-16 non-ASCII matching must preserve exact case");

    fs.writeFileSync(artifact, Buffer.from(exact, "utf16le"));
    assert.equal(runCheckWithTerms(root, [exact], "--tree-only", artifact).status, 1, "exact BOM-less UTF-16 non-ASCII term must be rejected");
    fs.writeFileSync(artifact, Buffer.from(differentCase, "utf16le"));
    assert.equal(runCheckWithTerms(root, [exact], "--tree-only", artifact).status, 0, "BOM-less UTF-16 non-ASCII matching must preserve exact case");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("short CJK terms require UTF-8 or BOM-marked UTF-16 while ASCII UTF-16 remains strict", () => {
  const root = fixture();
  const artifact = path.join(root, "encoding-policy-artifact.bin");
  const cjk = "\u9006\u5411";
  const ascii = "asciifixture";
  const toBigEndian = (value) => {
    const encoded = Buffer.from(value, "utf16le");
    for (let index = 0; index < encoded.length; index += 2) [encoded[index], encoded[index + 1]] = [encoded[index + 1], encoded[index]];
    return encoded;
  };
  try {
    fs.writeFileSync(artifact, Buffer.from(cjk, "utf8"));
    assert.equal(runCheckWithTerms(root, [cjk], "--tree-only", artifact).status, 1, "UTF-8 CJK marker must be rejected");

    for (const bytes of [
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cjk, "utf16le")]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), toBigEndian(cjk)]),
    ]) {
      fs.writeFileSync(artifact, bytes);
      assert.equal(runCheckWithTerms(root, [cjk], "--tree-only", artifact).status, 1, "BOM-marked UTF-16 CJK marker must be rejected");
    }

    for (const bytes of [Buffer.from(cjk, "utf16le"), toBigEndian(cjk)]) {
      fs.writeFileSync(artifact, Buffer.concat([Buffer.from([0xa5, 0x5a]), bytes, Buffer.from([0x5a, 0xa5])]));
      const clean = runCheckWithTerms(root, [cjk], "--tree-only", artifact);
      assert.equal(clean.status, 0, clean.stderr || clean.stdout);
    }

    const longCjk = `${cjk}\u4fe1`;
    fs.writeFileSync(artifact, Buffer.from(longCjk, "utf16le"));
    assert.equal(runCheckWithTerms(root, [longCjk], "--tree-only", artifact).status, 1, "three-codepoint BOM-less UTF-16 marker must be rejected");

    for (const bytes of [Buffer.from(ascii, "utf16le"), toBigEndian(ascii)]) {
      fs.writeFileSync(artifact, bytes);
      assert.equal(runCheckWithTerms(root, [ascii], "--tree-only", artifact).status, 1, "ASCII UTF-16 marker must be rejected");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("UTF-16 token boundaries exclude embedded mixed-case words", () => {
  const root = fixture();
  const artifact = path.join(root, "utf16-token-artifact.bin");
  const token = "ra" + "ft";
  try {
    fs.writeFileSync(artifact, Buffer.from(`D${token}00`, "utf16le"));
    const embedded = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
    assert.equal(embedded.status, 0, embedded.stderr || embedded.stdout);

    fs.writeFileSync(artifact, Buffer.from(` ${token} `, "utf16le"));
    const standalone = runCheckWithTerms(root, [`token:${token}`], "--tree-only", artifact);
    assert.equal(standalone.status, 1, standalone.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("private scan rejects derived names, NUL-delimited ASCII, and both UTF-16 byte orders", () => {
  const root = fixture();
  const artifact = path.join(root, "artifact.bin");
  try {
    fs.writeFileSync(artifact, Buffer.from("safe artifact"));
    assert.equal(runCheck(root, artifact).status, 0);

    const dottedMarker = marker.replaceAll("-", ".");
    const utf16le = Buffer.from(dottedMarker, "utf16le");
    const utf16be = Buffer.from(utf16le);
    for (let index = 0; index < utf16be.length; index += 2) [utf16be[index], utf16be[index + 1]] = [utf16be[index + 1], utf16be[index]];
    for (const bytes of [Buffer.concat([Buffer.from([0]), Buffer.from(`prefix-${marker}-suffix`), Buffer.from([0])]), utf16le, utf16be]) {
      fs.writeFileSync(artifact, bytes);
      const blocked = runCheck(root, artifact);
      assert.equal(blocked.status, 1, blocked.stdout);
      assert.match(blocked.stderr, /blocked by private publication denylist/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tree scan reads indexed symlink blobs and refuses untracked required files", () => {
  const root = fixture();
  try {
    fs.symlinkSync(marker, path.join(root, "linked-marker"));
    git(root, "add", "linked-marker");
    const linked = runCheck(root, "--tree-only");
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /index blob linked-marker: blocked by private publication denylist/);

    git(root, "reset", "--", "linked-marker");
    fs.unlinkSync(path.join(root, "linked-marker"));
    fs.writeFileSync(path.join(root, "binary.dat"), Buffer.concat([Buffer.from([0]), Buffer.from(marker), Buffer.from([0])]));
    git(root, "add", "binary.dat");
    const binary = runCheck(root, "--tree-only");
    assert.equal(binary.status, 1);
    assert.match(binary.stderr, /index blob binary\.dat: blocked by private publication denylist/);

    git(root, "reset", "--", "binary.dat");
    fs.unlinkSync(path.join(root, "binary.dat"));
    git(root, "rm", "--cached", "AGENTS.md");
    const untracked = runCheck(root, "--tree-only");
    assert.equal(untracked.status, 1);
    assert.match(untracked.stderr, /required publication file is not tracked in the Git index/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tree scan rejects internal documentation paths and non-allowlisted Markdown", () => {
  const root = fixture();
  const candidates = [
    ["docs/context.txt", "internal notes\n", /internal documentation path/],
    [".claude/settings.json", "{}\n", /internal documentation path/],
    ["DESIGN.md", "# Design\n", /Markdown file is outside the publication allowlist/],
  ];
  try {
    for (const [relative, contents, expected] of candidates) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
      git(root, "add", relative);
      const result = runCheck(root, "--tree-only");
      assert.equal(result.status, 1, `${relative}: ${result.stdout}`);
      assert.match(result.stderr, expected);
      git(root, "rm", "--cached", relative);
      fs.unlinkSync(absolute);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tree scan allows only the approved GitHub pull request Markdown template", () => {
  const root = fixture();
  try {
    const approved = ".github/pull_request_template.md";
    const rejected = ".github/README.md";
    for (const [relative, contents] of [[approved, "## Summary\n"], [rejected, "# Internal\n"]]) {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
      git(root, "add", relative);
    }
    const result = runCheck(root, "--tree-only");
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.doesNotMatch(result.stderr, /pull_request_template\.md/);
    assert.match(result.stderr, /\.github\/README\.md: Markdown file is outside the publication allowlist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default scan covers reachable history blobs, paths, and refs but not commit messages", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "temporary.txt"), marker);
    git(root, "add", "temporary.txt");
    git(root, "commit", "-m", marker);
    git(root, "rm", "temporary.txt");
    git(root, "commit", "-m", "Remove temporary file");
    assert.equal(runCheck(root, "--tree-only").status, 0, "tree preparation must ignore private predecessor objects");
    const history = runCheck(root);
    assert.equal(history.status, 1);
    assert.match(history.stderr, /history blob/);

    // Commit-message-only occurrences are metadata, not publication content:
    // the published tree never contains commit messages, so scanning them only
    // produced false positives (e.g. a message quoting a denied path while
    // describing cleanup of that path).
    const messageOnly = fixture();
    try {
      git(messageOnly, "commit", "--allow-empty", "-m", "message-only-marker");
      const clean = runCheckWithTerms(messageOnly, ["message-only-marker"]);
      assert.equal(clean.status, 0, clean.stderr || clean.stdout);
    } finally {
      fs.rmSync(messageOnly, { recursive: true, force: true });
    }

    const cleanRoot = fixture();
    try {
      git(cleanRoot, "branch", marker);
      const ref = runCheck(cleanRoot);
      assert.equal(ref.status, 1);
      assert.match(ref.stderr, /ref refs\/heads/);
    } finally {
      fs.rmSync(cleanRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("default history scan explicitly checks annotated tag contents", () => {
  const root = fixture();
  try {
    git(root, "tag", "-a", "v1.0.0", "-m", "Clean release annotation");
    const clean = runCheck(root);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);

    git(root, "tag", "-a", "v1.0.1", "-m", marker);
    const blocked = runCheck(root);
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.match(blocked.stderr, /annotated tag refs\/tags\/v1\.0\.1: blocked by private publication denylist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("public prose rejects generic historical review and commit pointers", () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, "README.md"), "See commit `1234567`, `feature/old-work`, and https://github.com/example/project/pull/12.\n");
    git(root, "add", "README.md");
    const result = runCheck(root, "--tree-only");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /historical (?:branch|commit|pull-request)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("license check rejects tampered declared-license metadata", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-license-tamper-"));
  const output = path.join(temp, "THIRD_PARTY_NOTICES.txt");
  try {
    const generated = command(ROOT, process.execPath, [path.join(ROOT, "scripts/generate-third-party-notices.mjs"), "--output", output]);
    assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    const original = fs.readFileSync(output, "utf8");
    const tampered = original.replace(" | MIT |", " | ISC |");
    assert.notEqual(tampered, original);
    fs.writeFileSync(output, tampered);
    const result = command(ROOT, process.execPath, [path.join(ROOT, "scripts/generate-third-party-notices.mjs"), "--check", "--output", output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /do(?:es)? not byte-match/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}, 120_000);
