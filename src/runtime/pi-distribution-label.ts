export function piDistributionLabel(distribution: "builtin" | "external" | null | undefined): string {
  return distribution === "builtin" ? "内置 Pi" : "用户安装的 Pi";
}
