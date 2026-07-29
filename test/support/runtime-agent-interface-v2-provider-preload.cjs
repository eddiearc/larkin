const childProcess = require("node:child_process");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");

const originalSpawnSync = childProcess.spawnSync;

childProcess.spawnSync = (command, args = [], options = {}) => {
  const pinnedPackageCli = command === process.execPath
    && String(args[0] || "").includes(`${path.sep}@larksuite${path.sep}cli${path.sep}scripts${path.sep}run.js`);
  const recordedGlobalCli = process.env.LARKIN_TEST_GLOBAL_CLI && command === process.env.LARKIN_TEST_GLOBAL_CLI;
  if (!pinnedPackageCli && !recordedGlobalCli) return originalSpawnSync(command, args, options);
  if (recordedGlobalCli && args.length === 1 && args[0] === "__runtime-delegate-capabilities") {
    return originalSpawnSync(command, args, options);
  }
  const provider = process.env.LARKIN_TEST_FRESHNESS_PROVIDER;
  if (!provider) throw new Error("freshness integration provider is not configured");
  return originalSpawnSync(process.execPath, [provider, ...(pinnedPackageCli ? args.slice(1) : args)], {
    ...options,
    env: {
      ...options.env,
      LARKIN_TEST_PROVIDER_PARENT_PID: String(process.pid),
    },
  });
};

syncBuiltinESMExports();
