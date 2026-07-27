const fs = require("node:fs");
const cp = require("node:child_process");
const net = require("node:net");
const original = fs.chmodSync;
const originalListen = net.Server.prototype.listen;
let replacedBeforeChmod = false;
let replacedBeforeListen = false;

function launchReplacement(file) {
  const marker = process.env.LARKIN_REPLACEMENT_READY;
  const code = `
const fs=require("node:fs"),net=require("node:net");
const socket=process.env.LARKIN_REPLACEMENT_SOCKET,marker=process.env.LARKIN_REPLACEMENT_READY;
const server=net.createServer(connection=>connection.end("replacement"));
server.listen(socket,()=>fs.writeFileSync(marker,"ready"));
process.once("SIGTERM",()=>server.close(()=>process.exit(0)));
`;
  const child = cp.spawn(process.execPath, ["-e", code], {
    env: {
      ...process.env,
      LARKIN_REPLACE_BEFORE_CHMOD: "",
      LARKIN_REPLACE_BEFORE_LISTEN: "",
      LARKIN_REPLACEMENT_SOCKET: String(file),
      LARKIN_REPLACEMENT_READY: marker,
    },
    stdio: "ignore",
  });
  global.__larkinReplacementChild = child;
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(marker)) throw new Error("replacement fixture readiness timeout");
}

net.Server.prototype.listen = function listen(...args) {
  const target = typeof args[0] === "string" ? args[0] : args[0]?.path;
  if (process.env.LARKIN_REPLACE_BEFORE_LISTEN === "1"
      && String(target).endsWith("/supervisor.sock") && !replacedBeforeListen) {
    replacedBeforeListen = true;
    launchReplacement(target);
  }
  return originalListen.apply(this, args);
};

fs.chmodSync = function chmodSync(file, mode) {
  if (String(file).endsWith("/supervisor.sock")) {
    if (process.env.LARKIN_REPLACE_BEFORE_CHMOD === "1" && !replacedBeforeChmod) {
      replacedBeforeChmod = true;
      fs.unlinkSync(file);
      launchReplacement(file);
    }
    const error = new Error("fixture chmod failure");
    error.code = "EACCES";
    throw error;
  }
  return original.call(this, file, mode);
};
require("node:module").syncBuiltinESMExports();
