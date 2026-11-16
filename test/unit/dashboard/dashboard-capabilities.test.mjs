import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULE = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-capabilities.mjs")).href;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function setup() {
  // The workspace is resolved with realpath, as Claude records its cwd; on macOS the tmpdir sits behind /var -> /private/var.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-capabilities-")));
  const home = path.join(temp, "home");
  const larkinHome = path.join(temp, "larkin");
  const agentId = "cli_capabilities1";
  const workspace = path.join(larkinHome, "agents", agentId);
  fs.mkdirSync(workspace, { recursive: true });
  const homes = { home, codexHome: path.join(home, ".codex"), claudeConfigDir: path.join(home, ".claude"), codexAdminSkills: path.join(temp, "etc-codex-skills") };
  return { temp, home, workspace, agentId, homes, config: { larkinHome, agents: { [agentId]: { agentId } } } };
}

function summary(items, kind) {
  return items.filter((item) => item.kind === kind).map(({ source, name, status, location }) => `${source}|${name}|${status}|${location}`);
}

test("Codex capabilities list workspace before global, honour skills.config, and keep MCP secrets out", async () => {
  const { temp, home, workspace, agentId, homes, config } = setup();
  try {
    const { collectCapabilities } = await import(MODULE);
    write(path.join(workspace, ".agents/skills/weekly-report/SKILL.md"), "---\nname: weekly-report\ndescription: 整理周报\n---\nbody");
    write(path.join(home, ".agents/skills/lark-im/SKILL.md"), "---\nname: lark-im\ndescription: >\n  收发飞书消息\n  查群\n---\n");
    write(path.join(home, ".agents/skills/imagegen/SKILL.md"), "---\nname: imagegen\ndescription: 生成配图\n---\n");
    write(path.join(home, ".agents/skills/notes/SKILL.md"), "---\nname: notes\n---\n");
    write(path.join(homes.codexAdminSkills, "team-style/SKILL.md"), "---\nname: team-style\ndescription: 团队规范\n---\n");
    write(path.join(home, ".codex/skills/.system/skill-creator/SKILL.md"), "---\nname: skill-creator\ndescription: 写新技能\n---\n");
    write(path.join(home, ".codex/plugins/cache/openai-curated/github/1.0.0/skills/gh-fix-ci/SKILL.md"), "---\nname: gh-fix-ci\ndescription: 修 CI\n---\n");
    write(path.join(workspace, ".codex/agents/reviewer.toml"), 'name = "reviewer"\ndescription = "审稿"\ndeveloper_instructions = """\nname = "not-a-key"\n"""\n');
    write(path.join(home, ".codex/agents/explorer.toml"), 'name = "explorer"\ndescription = "自定义的 explorer"\ndeveloper_instructions = "x"\n');
    write(path.join(home, ".codex/agents/broken.toml"), 'name = "broken"\n');
    write(path.join(home, ".codex/config.toml"), [
      'model = "gpt-5.5"',
      "[[skills.config]]",
      `path = "${path.join(home, ".agents/skills/imagegen/SKILL.md")}"`,
      "enabled = false",
      '[plugins."github@openai-curated"]',
      "enabled = true",
      "[mcp_servers]",
      'inline = { command = "node", args = ["server.js", "--key", "SECRET-INLINE"] }',
      "[mcp_servers.feishu-docs]",
      'command = "/usr/local/bin/npx"',
      'args = ["feishu-mcp", "--token", "SECRET-ARG"]',
      "[mcp_servers.feishu-docs.env]",
      'FEISHU_APP_SECRET = "SECRET-ENV"',
      "[mcp_servers.remote]",
      'url = "https://mcp.example.com/sse?key=SECRET-QUERY"',
      "enabled = false",
    ].join("\n"));

    const view = collectCapabilities(config, agentId, "codex", homes);
    assert.deepEqual(view.unsupported, []);
    assert.deepEqual(summary(view.items, "skill"), [
      "workspace|weekly-report|ok|.agents/skills/weekly-report/SKILL.md",
      "global|imagegen|disabled|~/.agents/skills/imagegen/SKILL.md",
      "global|lark-im|ok|~/.agents/skills/lark-im/SKILL.md",
      "global|notes|invalid|~/.agents/skills/notes/SKILL.md",
      `global|team-style|ok|${path.join(homes.codexAdminSkills, "team-style/SKILL.md")}`,
      "plugin|github:gh-fix-ci|ok|~/.codex/plugins/cache/openai-curated/github/1.0.0/skills/gh-fix-ci/SKILL.md",
      "builtin|skill-creator|ok|~/.codex/skills/.system/skill-creator/SKILL.md",
    ]);
    assert.equal(view.items.find((item) => item.name === "lark-im").description, "收发飞书消息 查群");
    assert.equal(view.items.find((item) => item.name === "notes").detail, "缺少 description");
    assert.deepEqual(summary(view.items, "subagent"), [
      "workspace|reviewer|ok|.codex/agents/reviewer.toml",
      "global|broken|invalid|~/.codex/agents/broken.toml",
      "global|explorer|ok|~/.codex/agents/explorer.toml",
      "builtin|default|ok|Codex 自带",
      "builtin|worker|ok|Codex 自带",
      "builtin|explorer|shadowed|Codex 自带",
    ]);
    assert.deepEqual(summary(view.items, "plugin"), ["global|github@openai-curated|ok|~/.codex/config.toml"]);
    assert.deepEqual(view.items.filter((item) => item.kind === "mcp").map(({ name, description, status }) => `${name}|${description}|${status}`), [
      "inline|stdio · node|ok",
      "feishu-docs|stdio · npx|ok",
      "remote|HTTP · https://mcp.example.com|disabled",
    ]);
    assert.doesNotMatch(JSON.stringify(view), /SECRET|body|not-a-key/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Claude capabilities include plugin skills and agents, MCP scopes, and project agents winning over user ones", async () => {
  const { temp, home, workspace, agentId, homes, config } = setup();
  try {
    const { collectCapabilities } = await import(MODULE);
    const pluginDir = path.join(home, ".claude/plugins/cache/market/figma/2.0.0");
    write(path.join(workspace, ".claude/skills/weekly/SKILL.md"), "---\nname: weekly\ndescription: 周报\n---\n");
    write(path.join(home, ".claude/skills/lark/SKILL.md"), "---\nname: lark\ndescription: 飞书\n---\n");
    write(path.join(workspace, ".claude/agents/reviewer.md"), "---\nname: reviewer\ndescription: 项目审稿\n---\n");
    write(path.join(home, ".claude/agents/reviewer.md"), "---\nname: reviewer\ndescription: 个人审稿\n---\n");
    write(path.join(pluginDir, "skills/figma-use/SKILL.md"), "---\nname: figma-use\ndescription: 用 Figma\n---\n");
    write(path.join(pluginDir, "agents/designer.md"), "---\nname: designer\ndescription: 设计\n---\n");
    write(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "figma@market": [{ scope: "user", installPath: pluginDir }] } }));
    write(path.join(home, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "figma@market": false } }));
    write(path.join(home, ".claude.json"), JSON.stringify({
      mcpServers: { github: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer SECRET" } } },
      projects: { [workspace]: { mcpServers: { local: { command: "node", args: ["SECRET"] } } } },
    }));
    write(path.join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp", env: { TOKEN: "SECRET" } } } }));

    const view = collectCapabilities(config, agentId, "claude", homes);
    assert.deepEqual(summary(view.items, "skill"), [
      "workspace|weekly|ok|.claude/skills/weekly/SKILL.md",
      "global|lark|ok|~/.claude/skills/lark/SKILL.md",
      "plugin|figma:figma-use|disabled|~/.claude/plugins/cache/market/figma/2.0.0/skills/figma-use/SKILL.md",
    ]);
    assert.deepEqual(summary(view.items, "subagent").slice(0, 3), [
      "workspace|reviewer|ok|.claude/agents/reviewer.md",
      "global|reviewer|shadowed|~/.claude/agents/reviewer.md",
      "plugin|figma:designer|disabled|~/.claude/plugins/cache/market/figma/2.0.0/agents/designer.md",
    ]);
    assert.deepEqual(summary(view.items, "plugin"), ["global|figma@market|disabled|~/.claude/settings.json"]);
    assert.deepEqual(summary(view.items, "mcp"), [
      "workspace|local|ok|~/.claude.json（本工作区）",
      "workspace|github|ok|.mcp.json",
      "global|github|shadowed|~/.claude.json",
    ]);
    assert.doesNotMatch(JSON.stringify(view), /SECRET/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Pi lists skills only and reports the kinds it does not have", async () => {
  const { temp, home, workspace, agentId, homes, config } = setup();
  try {
    const { collectCapabilities } = await import(MODULE);
    write(path.join(workspace, ".pi/skills/a/SKILL.md"), "---\nname: a\ndescription: A\n---\n");
    write(path.join(home, ".pi/agent/skills/b/SKILL.md"), "---\nname: b\ndescription: B\n---\n");
    const view = collectCapabilities(config, agentId, "pi", homes);
    assert.deepEqual(summary(view.items, "skill"), ["workspace|a|ok|.pi/skills/a/SKILL.md", "global|b|ok|~/.pi/agent/skills/b/SKILL.md"]);
    assert.deepEqual(view.unsupported, ["subagent", "plugin", "mcp"]);
    assert.throws(() => collectCapabilities(config, "cli_missing", "pi", homes), (error) => error.statusCode === 404);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
