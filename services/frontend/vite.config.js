import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production the app and the APIs share one origin behind Traefik, so the
// app calls relative paths (/auth/..., /dashboard/...). For `npm run dev`,
// forward those paths to the running gateway.
const gateway = "http://localhost";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/auth": gateway,
      "/student": gateway,
      "/dashboard": gateway,
    },
  },
});
