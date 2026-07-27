// Bun compile entry. Static `text` imports put the Dashboard runtime bytes in the executable.
import mark from "../../assets/larkin-mark.svg" with { type: "text" };
import css from "../../dist/dashboard/web/assets/dashboard.css" with { type: "text" };
import javascript from "../../dist/dashboard/web/assets/dashboard.js" with { type: "text" };
import { main } from "../../dist/app/binary-entry.mjs";

const encoder = new TextEncoder();

globalThis.__LARKIN_EMBEDDED_DASHBOARD_ASSETS__ = Object.freeze({
  "larkin-mark.svg": encoder.encode(mark),
  "dashboard.css": encoder.encode(css),
  "dashboard.js": encoder.encode(javascript),
});
process.env.LARKIN_STANDALONE = "1";
// Bun preserves the wrapper entry at argv[1]; the public binary contract is argv[1] = first user argument.
process.argv.splice(1, 1);

await main();
