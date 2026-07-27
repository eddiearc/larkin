import path from "node:path";
import { acquireProcessLock } from "../../dist/platform/process-state.mjs";

const file = process.argv[2];
const lock = acquireProcessLock(file, path.basename(process.argv[1]));
const stop = () => { lock.release(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdout.write("READY\n");
setInterval(() => {}, 60_000);
