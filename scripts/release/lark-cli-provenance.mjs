export const LARK_CLI_VERSION = "1.0.78";

export const LARK_CLI_NATIVE_SHA256 = Object.freeze({
  "darwin-x64": "afb594d5fb24ccfa55d5b9d21757508aa3bfc356e84e7f0683e59e9c57d9a4f8",
  "darwin-arm64": "ec0abdebab5704a750f8782a45260314f2a1f758831d062eac1536870390cf6a",
  "linux-x64": "949ccdf5ccc0821ade80983247237183436be4a279b429b59b743dd4ff88c2a8",
  "linux-arm64": "ac4c356ba4415cc91cfd474fa27e5cfcfb2208aa7b6408bcea6e820e6627cd0d",
});

export function larkCliTarget(platform, arch) {
  const archivePlatform = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "windows";
  const archiveArch = arch === "x64" ? "amd64" : arch;
  const extension = archivePlatform === "windows" ? "zip" : "tar.gz";
  return {
    key: `${platform}-${arch}`,
    archive: `lark-cli-${LARK_CLI_VERSION}-${archivePlatform}-${archiveArch}.${extension}`,
  };
}
