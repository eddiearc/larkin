const childProcess = require("node:child_process");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const originalSpawnSync = childProcess.spawnSync;

childProcess.spawnSync = (command, args = [], options = {}) => {
  const verifiedGlobalCli = process.env.LARKIN_TEST_OFFICIAL_LARK_CLI;
  if (verifiedGlobalCli && path.resolve(String(command)) === path.resolve(verifiedGlobalCli)) {
    if (args[0] === "--version" || (args[0] === "config" && args[1] === "bind" && args[2] === "--help")) {
      return originalSpawnSync(command, args, options);
    }
    const provider = process.env.LARKIN_TEST_FRESHNESS_PROVIDER;
    if (!provider) throw new Error("freshness integration provider is not configured");
    return originalSpawnSync(process.execPath, [provider, ...args], {
      ...options,
      env: { ...options.env, LARKIN_TEST_PROVIDER_PARENT_PID: String(process.pid) },
    });
  }
  const pinnedPackageCli = command === process.execPath
    && String(args[0] || "").includes(`${path.sep}@larksuite${path.sep}cli${path.sep}scripts${path.sep}run.js`);
  if (!pinnedPackageCli) return originalSpawnSync(command, args, options);
  const provider = process.env.LARKIN_TEST_FRESHNESS_PROVIDER;
  if (!provider) throw new Error("freshness integration provider is not configured");
  return originalSpawnSync(process.execPath, [provider, ...args.slice(1)], {
    ...options,
    env: {
      ...options.env,
      LARKIN_TEST_PROVIDER_PARENT_PID: String(process.pid),
    },
  });
};

syncBuiltinESMExports();
