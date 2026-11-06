import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Seven real .html entries, not a single-page app: a static host serves each one directly, and the import's route
// discovery reads these same entries. Two of them (account, staff) are behind an account in the finished product,
// but as supplied they are plain pages — the frontend cannot gate itself without a backend, and pretending
// otherwise is exactly the kind of fake the design lock exists to catch.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        services: resolve(__dirname, "services.html"),
        book: resolve(__dirname, "book.html"),
        register: resolve(__dirname, "register.html"),
        login: resolve(__dirname, "login.html"),
        account: resolve(__dirname, "account.html"),
        staff: resolve(__dirname, "staff.html"),
      },
    },
  },
});
