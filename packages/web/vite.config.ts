import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const instance = process.env.MASTERMIND_URL ?? "http://127.0.0.1:4700";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: instance, ws: true },
    },
  },
});
