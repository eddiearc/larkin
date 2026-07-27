// Dashboard HTML shell only. Product UI lives in src/dashboard/web and is built by Vite;
// this template injects per-process public bootstrap values without duplicating frontend state.

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderDashboardHtml(
  packageVersion: unknown,
  dashboardVersion: unknown = packageVersion,
  buildFingerprint: unknown = null,
  csrfCapability: unknown = null,
): string {
  const bootstrap = safeJson({
    packageVersion: String(packageVersion || "dev"),
    dashboardVersion: String(dashboardVersion || packageVersion || "dev"),
    buildFingerprint: String(buildFingerprint || ""),
    csrfCapability: String(csrfCapability || ""),
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#A3402C">
  <title>LARKIN · Dashboard</title>
  <link rel="icon" href="/assets/larkin-mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/dashboard-assets/dashboard.css">
</head>
<body>
  <div id="root"><p style="padding:24px;font-family:system-ui">Loading Larkin Agent workbench…</p></div>
  <script>window.__LARKIN_DASHBOARD__=${bootstrap};</script>
  <script type="module" src="/dashboard-assets/dashboard.js"></script>
</body>
</html>`;
}
