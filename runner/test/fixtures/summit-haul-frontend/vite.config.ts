import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// A multi-page build, not a single-page app. Each page is a real .html entry, so the site is three genuine
// routes a static host serves directly -- which is also what the import's route discovery reads.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        services: resolve(__dirname, "services.html"),
        quote: resolve(__dirname, "quote.html"),
      },
    },
  },
});
