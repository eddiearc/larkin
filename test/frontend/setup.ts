import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "__LARKIN_DASHBOARD__", {
  configurable: true,
  writable: true,
  value: { packageVersion: "test", dashboardVersion: "test", buildFingerprint: "", csrfCapability: "csrf-test" },
});

Object.defineProperty(window, "scrollTo", { configurable: true, writable: true, value: () => {} });
