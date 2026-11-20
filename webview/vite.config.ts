import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("../media", import.meta.url)),
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
