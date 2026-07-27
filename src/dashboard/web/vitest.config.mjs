import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export default defineConfig({
  root,
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: [path.join(root, "test/frontend/setup.ts")],
    include: ["test/frontend/**/*.test.ts", "test/frontend/**/*.test.tsx"],
    restoreMocks: true,
  },
});
