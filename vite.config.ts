import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works from a domain root or any project subpath.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
});
