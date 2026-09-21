import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemon = `http://127.0.0.1:${process.env.TC_PORT ?? 4700}`;

export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: { host: "127.0.0.1", port: 4701, proxy: { "/api": { target: daemon, changeOrigin: false } } },
});
