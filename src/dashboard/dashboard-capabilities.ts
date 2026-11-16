import fs from "node:fs";
import path from "node:path";
import { workspaceRootForAgent, type DashboardWorkspaceConfig } from "./dashboard-workspace.js";

export type CapabilityKind = "skill" | "subagent" | "plugin" | "mcp";
export type CapabilitySource = "workspace" | "global" | "plugin" | "builtin";
export type CapabilityStatus = "ok" | "disabled" | "invalid" | "shadowed";

export interface CapabilityItem {
  kind: CapabilityKind;
  source: CapabilitySource;
  name: string;
  description: string | null;
  /** Display location: workspace-relative, `~/…`, or a short label. Never secrets. */
  location: string;
  status: CapabilityStatus;
  detail: string | null;
}

export interface CapabilitiesView {
  runtime: string;
  items: CapabilityItem[];
  /** Kinds the runtime has no concept of, so the UI can say so instead of showing an empty list. */
  unsupported: CapabilityKind[];
}

export interface CapabilityHomes {
  home: string;
  codexHome: string;
  claudeConfigDir: string;
  /** Codex admin skills, `/etc/codex/skills` on a real host. */
  codexAdminSkills: string;
}

const MAX_ENTRIES_PER_DIR = 200;
const MAX_HEADER_BYTES = 16 * 1024;

// Bun-only runtime: the dashboard server always runs under Bun, which ships a full TOML parser.
declare const Bun: { TOML: { parse(text: string): unknown } };

/** A TOML document as a plain object; unreadable or invalid TOML reads as empty. */
function readToml(text: string): Record<string, unknown> {
  try { return asRecord(Bun.TOML.parse(text)); } catch { return {}; }
}

/** The sub-tables of `table`, e.g. each `[mcp_servers.<name>]` or `[mcp_servers] <name> = { … }` server. */
function subTables(table: unknown): Array<[string, Record<string, unknown>]> {
  return Object.entries(asRecord(table)).flatMap(([name, value]) => value && typeof value === "object" && !Array.isArray(value)
    ? [[name, value as Record<string, unknown>]] as Array<[string, Record<string, unknown>]> : []);
}

/** Frontmatter `key: value` pairs from a Markdown file, including `|` / `>` block scalars. */
export function readFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (!pair) continue;
    let value = pair[2].trim();
    if (/^[|>][-+]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index].trim());
      value = block.join(value.startsWith(">") ? " " : "\n").trim();
    }
    fields[pair[1]] = value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
  return fields;
}

function readHead(file: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } catch { return null; }
  finally { if (fd !== null) fs.closeSync(fd); }
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function listDir(dir: string): fs.Dirent[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_ENTRIES_PER_DIR); }
  catch { return []; }
}

function isDirectory(entry: fs.Dirent, parent: string): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return fs.statSync(path.join(parent, entry.name)).isDirectory(); } catch { return false; }
}

class Display {
  constructor(private readonly workspace: string, private readonly home: string) {}
  path(file: string): string {
    if (file === this.workspace || file.startsWith(`${this.workspace}${path.sep}`)) return path.relative(this.workspace, file).split(path.sep).join("/") || ".";
    if (file.startsWith(`${this.home}${path.sep}`)) return `~/${path.relative(this.home, file).split(path.sep).join("/")}`;
    return file;
  }
}

function skillsIn(dir: string, source: CapabilitySource, display: Display, disabled: Set<string> = new Set()): CapabilityItem[] {
  return listDir(dir).filter((entry) => isDirectory(entry, dir)).map((entry) => {
    const file = path.join(dir, entry.name, "SKILL.md");
    const head = readHead(file);
    const fields = head === null ? {} : readFrontmatter(head);
    const missing = head === null ? ["SKILL.md"] : ["name", "description"].filter((key) => !fields[key]);
    const off = disabled.has(path.resolve(file));
    return {
      kind: "skill", source, name: fields.name || entry.name, description: fields.description || null, location: display.path(file),
      status: missing.length ? "invalid" : off ? "disabled" : "ok",
      detail: missing.length ? `缺少 ${missing.join("、")}` : off ? "在 config.toml 的 skills.config 里停用" : null,
    } satisfies CapabilityItem;
  });
}

function markdownAgentsIn(dir: string, source: CapabilitySource, display: Display): CapabilityItem[] {
  return listDir(dir).filter((entry) => entry.name.endsWith(".md")).map((entry) => {
    const file = path.join(dir, entry.name);
    const fields = readFrontmatter(readHead(file) || "");
    const missing = ["name", "description"].filter((key) => !fields[key]);
    return {
      kind: "subagent", source, name: fields.name || entry.name.replace(/\.md$/, ""), description: fields.description || null,
      location: display.path(file), status: missing.length ? "invalid" : "ok", detail: missing.length ? `缺少 ${missing.join("、")}` : null,
    } satisfies CapabilityItem;
  });
}

function tomlAgentsIn(dir: string, source: CapabilitySource, display: Display): CapabilityItem[] {
  return listDir(dir).filter((entry) => entry.name.endsWith(".toml")).map((entry) => {
    const file = path.join(dir, entry.name);
    const text = readText(file) || "";
    const root = readToml(text);
    const missing = ["name", "description", "developer_instructions"].filter((key) => typeof root[key] !== "string" || !root[key]);
    return {
      kind: "subagent", source, name: typeof root.name === "string" && root.name ? root.name : entry.name.replace(/\.toml$/, ""),
      description: typeof root.description === "string" ? root.description : null, location: display.path(file),
      status: missing.length ? "invalid" : "ok", detail: missing.length ? `缺少 ${missing.join("、")}` : null,
    } satisfies CapabilityItem;
  });
}

function builtins(kind: CapabilityKind, names: Array<[string, string]>, label: string): CapabilityItem[] {
  return names.map(([name, description]) => ({ kind, source: "builtin", name, description, location: label, status: "ok", detail: null }));
}

/** Later sources lose to earlier ones with the same name (workspace > global > plugin > built-in). */
function markShadowed(items: CapabilityItem[]): CapabilityItem[] {
  const seen = new Map<string, CapabilityItem>();
  return items.map((item) => {
    const winner = seen.get(item.name);
    if (!winner) { seen.set(item.name, item); return item; }
    return { ...item, status: "shadowed", detail: `被${winner.source === "workspace" ? "工作区" : winner.source === "global" ? "全局" : "插件"}里的同名项覆盖` };
  });
}

function mcpItem(name: string, server: Record<string, unknown>, source: CapabilitySource, location: string, enabled = true): CapabilityItem {
  // Only the transport is shown: args, env and headers routinely carry tokens.
  let transport = "未知传输方式";
  if (typeof server.url === "string") {
    try { transport = `HTTP · ${new URL(server.url).origin}`; } catch { transport = "HTTP"; }
  } else if (typeof server.command === "string") transport = `stdio · ${path.basename(server.command)}`;
  return { kind: "mcp", source, name, description: transport, location, status: enabled && server.enabled !== false ? "ok" : "disabled", detail: null };
}

function codexCapabilities(workspace: string, homes: CapabilityHomes, display: Display): CapabilityItem[] {
  const configFile = path.join(homes.codexHome, "config.toml");
  const codexConfig = readToml(readText(configFile) || "");
  const skillConfigs = asRecord(codexConfig.skills).config;
  const disabledSkills = new Set((Array.isArray(skillConfigs) ? skillConfigs.map(asRecord) : [])
    .filter((entry) => entry.enabled === false && typeof entry.path === "string")
    .map((entry) => path.resolve(String(entry.path).replace(/^~(?=\/)/, homes.home))));
  const plugins = subTables(codexConfig.plugins).map(([id, entry]) => ({ id, enabled: entry.enabled !== false }));
  const pluginSkills = plugins.flatMap((plugin) => {
    const [pluginName, marketplace] = plugin.id.split("@");
    const versions = path.join(homes.codexHome, "plugins", "cache", marketplace || "", pluginName);
    const latest = listDir(versions).filter((entry) => isDirectory(entry, versions)).map((entry) => entry.name).pop();
    if (!latest) return [];
    return skillsIn(path.join(versions, latest, "skills"), "plugin", display, disabledSkills)
      .map((item) => ({ ...item, name: `${pluginName}:${item.name}`, status: plugin.enabled ? item.status : "disabled" as const, detail: plugin.enabled ? item.detail : `插件 ${plugin.id} 已停用` }));
  });
  const mcp = subTables(codexConfig.mcp_servers).map(([name, entry]) => mcpItem(name, entry, "global", display.path(configFile)));
  return [
    ...skillsIn(path.join(workspace, ".agents", "skills"), "workspace", display, disabledSkills),
    ...skillsIn(path.join(homes.home, ".agents", "skills"), "global", display, disabledSkills),
    ...skillsIn(homes.codexAdminSkills, "global", display, disabledSkills),
    ...pluginSkills,
    ...skillsIn(path.join(homes.codexHome, "skills", ".system"), "builtin", display, disabledSkills),
    ...markShadowed([
      ...tomlAgentsIn(path.join(workspace, ".codex", "agents"), "workspace", display),
      ...tomlAgentsIn(path.join(homes.codexHome, "agents"), "global", display),
      ...builtins("subagent", [["default", "通用的默认 Agent"], ["worker", "负责实现和修复"], ["explorer", "只读地查看代码和文件"]], "Codex 自带"),
    ]),
    ...plugins.map((plugin) => ({ kind: "plugin" as const, source: "global" as const, name: plugin.id, description: null, location: display.path(configFile), status: plugin.enabled ? "ok" as const : "disabled" as const, detail: null })),
    ...mcp,
  ];
}

function claudeCapabilities(workspace: string, homes: CapabilityHomes, display: Display): CapabilityItem[] {
  const settings = readJsonObject(path.join(homes.claudeConfigDir, "settings.json"));
  const enabledPlugins = asRecord(settings.enabledPlugins);
  const installed = asRecord(readJsonObject(path.join(homes.claudeConfigDir, "plugins", "installed_plugins.json")).plugins);
  const plugins = Object.entries(installed).map(([id, installs]) => {
    const install = asRecord(Array.isArray(installs) ? installs[0] : installs);
    return { id, enabled: enabledPlugins[id] === true, installPath: typeof install.installPath === "string" ? install.installPath : null };
  });
  const fromPlugins = plugins.flatMap((plugin) => {
    if (!plugin.installPath) return [];
    const pluginName = plugin.id.split("@")[0];
    const scoped = (item: CapabilityItem) => ({ ...item, name: `${pluginName}:${item.name}`,
      status: plugin.enabled ? item.status : "disabled" as const, detail: plugin.enabled ? item.detail : `插件 ${plugin.id} 未启用` });
    return [
      ...skillsIn(path.join(plugin.installPath, "skills"), "plugin", display).map(scoped),
      ...markdownAgentsIn(path.join(plugin.installPath, "agents"), "plugin", display).map(scoped),
    ];
  });
  // `.claude.json` sits beside the config dir by default, inside it when CLAUDE_CONFIG_DIR is set.
  const stateFile = homes.claudeConfigDir === path.join(homes.home, ".claude") ? path.join(homes.home, ".claude.json") : path.join(homes.claudeConfigDir, ".claude.json");
  const state = readJsonObject(stateFile);
  const local = asRecord(asRecord(asRecord(state.projects)[workspace]).mcpServers);
  const project = asRecord(readJsonObject(path.join(workspace, ".mcp.json")).mcpServers);
  const user = asRecord(state.mcpServers);
  return [
    ...skillsIn(path.join(workspace, ".claude", "skills"), "workspace", display),
    ...skillsIn(path.join(homes.claudeConfigDir, "skills"), "global", display),
    ...fromPlugins.filter((item) => item.kind === "skill"),
    ...markShadowed([
      ...markdownAgentsIn(path.join(workspace, ".claude", "agents"), "workspace", display),
      ...markdownAgentsIn(path.join(homes.claudeConfigDir, "agents"), "global", display),
      ...fromPlugins.filter((item) => item.kind === "subagent"),
      ...builtins("subagent", [["general-purpose", "通用的多步骤任务"], ["Explore", "只读地搜索和查看代码"], ["Plan", "做实现方案"]], "Claude Code 自带"),
    ]),
    ...plugins.map((plugin) => ({ kind: "plugin" as const, source: "global" as const, name: plugin.id, description: null, location: display.path(path.join(homes.claudeConfigDir, "settings.json")), status: plugin.enabled ? "ok" as const : "disabled" as const, detail: null })),
    ...markShadowed([
      ...Object.entries(local).map(([name, server]) => mcpItem(name, asRecord(server), "workspace", `${display.path(stateFile)}（本工作区）`)),
      ...Object.entries(project).map(([name, server]) => mcpItem(name, asRecord(server), "workspace", ".mcp.json")),
      ...Object.entries(user).map(([name, server]) => mcpItem(name, asRecord(server), "global", display.path(stateFile))),
    ]),
  ];
}

function piCapabilities(workspace: string, homes: CapabilityHomes, display: Display): CapabilityItem[] {
  return [
    ...skillsIn(path.join(workspace, ".pi", "skills"), "workspace", display),
    ...skillsIn(path.join(workspace, ".agents", "skills"), "workspace", display),
    ...skillsIn(path.join(homes.home, ".pi", "agent", "skills"), "global", display),
    ...skillsIn(path.join(homes.home, ".agents", "skills"), "global", display),
  ];
}

export function defaultCapabilityHomes(env: NodeJS.ProcessEnv, home: string): CapabilityHomes {
  return {
    home,
    codexHome: env.CODEX_HOME || path.join(home, ".codex"),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    codexAdminSkills: "/etc/codex/skills",
  };
}

/** Read-only view of what an Agent's runtime will load in a new session; never returns file bodies or secrets. */
export function collectCapabilities(config: DashboardWorkspaceConfig, agentId: string, runtime: string, homes: CapabilityHomes): CapabilitiesView {
  const workspace = workspaceRootForAgent(config, agentId);
  const display = new Display(workspace, homes.home);
  if (runtime === "codex") return { runtime, items: codexCapabilities(workspace, homes, display), unsupported: [] };
  if (runtime === "claude") return { runtime, items: claudeCapabilities(workspace, homes, display), unsupported: [] };
  return { runtime, items: piCapabilities(workspace, homes, display), unsupported: ["subagent", "plugin", "mcp"] };
}
