import fs from "node:fs";

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(value) {
  const match = STABLE_SEMVER.exec(String(value || ""));
  if (!match) throw new Error(`不是稳定 semver: ${value || "missing"}`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`semver 数字超出安全范围: ${value}`);
  return parts;
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return Math.sign(leftParts[index] - rightParts[index]);
  }
  return 0;
}

export function nextStableVersion(current, request) {
  const [major, minor, patch] = parseStableVersion(current);
  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "major") return `${major + 1}.0.0`;
  parseStableVersion(request);
  if (compareStableVersions(request, current) <= 0) {
    throw new Error(`目标版本必须高于当前版本 ${current}: ${request}`);
  }
  return request;
}

export function updateManifestVersion(packageFile, request) {
  const manifest = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const current = String(manifest.version || "");
  const version = nextStableVersion(current, request);
  manifest.version = version;
  fs.writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { current, version };
}

export function assertReleaseTag(version, tag) {
  parseStableVersion(version);
  if (tag !== `v${version}`) throw new Error(`release tag ${tag} 与 package.json v${version} 不一致`);
  return version;
}
