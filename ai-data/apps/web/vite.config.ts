import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "WEB_");
  const target = process.env.WEB_API_TARGET ?? env.WEB_API_TARGET ?? "http://127.0.0.1:3101";
  return {
    plugins: [vue()],
    worker: { format: "es" },
    server: {
      proxy: {
        "/auth/": { target, changeOrigin: true },
        "/api/": {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api(?=\/)/, ""),
        },
      },
    },
  };
});
