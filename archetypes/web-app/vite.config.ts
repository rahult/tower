import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "web",
	plugins: [react()],
	server: {
		proxy: { "/api": `http://localhost:${process.env.API_PORT ?? 8787}` },
	},
});
