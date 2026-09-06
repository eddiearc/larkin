export const CONFIG_CLI_OPERATIONS = Object.freeze(["show", "runtime", "model", "effort", "mention", "inbox-audit", "apply"] as const);

export const CONFIG_CLI_USAGE = Object.freeze([
  "larkin config show [--agent <App ID>] [--chat <oc_id>] [--json]",
  "larkin config runtime <runtime> [--model <model>] [--agent <App ID>]",
  "larkin config model <model|default> [--agent <App ID>]",
  "larkin config effort <level|clear|default> [--agent <App ID>]",
  "larkin config mention global <require|free>",
  "larkin config mention agent <inherit|require|free> [--agent <App ID>]",
  "larkin config mention chat <oc_id> <inherit|require|free> [--agent <App ID>]",
  "larkin config inbox-audit global <on|off> [--interval <15m|1h>]",
  "larkin config inbox-audit agent <inherit|on|off> [--agent <App ID>] [--interval <15m|inherit>]",
  "larkin config apply [--agent <App ID>]",
]);

export const CONFIG_CLI_VALUES = Object.freeze({
  default: "do not persist an override",
  clear: "clear effort",
  inherit: "clear mention override",
});
