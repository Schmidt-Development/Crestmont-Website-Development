import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Six real .html entries. The catalogue, the item page and the two dashboards are separate routes rather than one
// app shell, because that is what the approved design is and what the import's route discovery reads.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        item: resolve(__dirname, "item.html"),
        join: resolve(__dirname, "join.html"),
        login: resolve(__dirname, "login.html"),
        account: resolve(__dirname, "account.html"),
        admin: resolve(__dirname, "admin.html"),
      },
    },
  },
});
