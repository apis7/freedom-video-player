import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        watch: {
            ignored: ["**/src-tauri/**", "**/UI_mockup/**", "**/md_files/**"],
        },
    },
    resolve: {
        alias: {
            "@": "/src",
        },
    },
    envPrefix: ["VITE_", "TAURI_ENV_"],
    build: {
        target: "esnext",
        minify: "esbuild",
        sourcemap: false,
    },
});
