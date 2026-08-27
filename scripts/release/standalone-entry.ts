// Bun compile entry. Static `text` imports put the Dashboard runtime bytes in the executable.
import mark from "../../assets/larkin-mark.svg" with { type: "text" };
import css from "../../dist/dashboard/web/assets/dashboard.css" with { type: "text" };
import javascript from "../../dist/dashboard/web/assets/dashboard.js" with { type: "text" };
import piPackageJson from "../../node_modules/@earendil-works/pi-coding-agent/package.json" with { type: "text" };
import piDarkTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json" with { type: "text" };
import piLightTheme from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/light.json" with { type: "text" };
import piSubagentsBundle from "../../dist/runtime/pi-subagents.bundle.js" with { type: "text" };
import piBashTimeoutBundle from "../../dist/runtime/pi-bash-timeout.bundle.js" with { type: "text" };
import piSubagentRecordWatchdogBundle from "../../dist/runtime/pi-subagent-record-watchdog.bundle.js" with { type: "text" };
import piSupervisedCommandBundle from "../../dist/runtime/pi-supervised-command.bundle.js" with { type: "text" };
import { main } from "../../dist/app/binary-entry.mjs";

const encoder = new TextEncoder();

globalThis.__LARKIN_EMBEDDED_DASHBOARD_ASSETS__ = Object.freeze({
  "larkin-mark.svg": encoder.encode(mark),
  "dashboard.css": encoder.encode(css),
  "dashboard.js": encoder.encode(javascript),
});
globalThis.__LARKIN_EMBEDDED_BUILTIN_PI_ASSETS__ = Object.freeze({
  packageJson: piPackageJson,
  darkTheme: piDarkTheme,
  lightTheme: piLightTheme,
});
globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__ = piSubagentsBundle;
globalThis.__LARKIN_EMBEDDED_PI_BASH_TIMEOUT_BUNDLE__ = piBashTimeoutBundle;
globalThis.__LARKIN_EMBEDDED_PI_SUBAGENT_RECORD_WATCHDOG_BUNDLE__ = piSubagentRecordWatchdogBundle;
globalThis.__LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__ = piSupervisedCommandBundle;
process.env.LARKIN_STANDALONE = "1";
// Bun preserves the wrapper entry at argv[1]; the public binary contract is argv[1] = first user argument.
process.argv.splice(1, 1);

await main();
