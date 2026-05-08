import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [tailwindcss()],
	server: {
		// Lokale Entwicklung: Proxy /api/proxy auf VPS-Backend, damit
		// `npm run dev` ohne lokalen Proxy-Service auskommt.
		// Im Produktiv-Build (npm run build) wird stattdessen nginx
		// auf docs.og-monschau.de den Proxy ausliefern.
		proxy: {
			"/api/proxy": {
				target: "https://docs.og-monschau.de",
				changeOrigin: true,
				secure: true,
			},
		},
	},
	build: {
		target: "es2022",
		sourcemap: false,
		rollupOptions: {
			output: {
				// Hashed Asset-Namen → lange Cache-Lifetime möglich
				entryFileNames: "assets/[name]-[hash].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
});
