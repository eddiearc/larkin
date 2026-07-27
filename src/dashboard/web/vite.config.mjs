import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.LARKIN_DASHBOARD_OUT_DIR || path.resolve(root, "../../../../dist/dashboard/web");

export default defineConfig({
  root,
  base: "/dashboard-assets/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.join(root, "main.tsx"),
      output: {
        entryFileNames: "assets/dashboard.js",
        chunkFileNames: "assets/chunk-[hash].js",
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".css") ? "assets/dashboard.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
