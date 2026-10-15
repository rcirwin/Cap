import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

const selfHostManifest = (env: Record<string, string>): Plugin => ({
	name: "cap-self-host-manifest",
	apply: "build",
	closeBundle() {
		const apiBaseUrl = env.VITE_CAP_API_BASE_URL?.trim();
		const manifestKey = env.CAP_EXTENSION_MANIFEST_KEY?.trim();
		if (!apiBaseUrl && !manifestKey) return;

		const manifestPath = resolve(__dirname, "dist/manifest.json");
		const manifest: Record<string, unknown> = JSON.parse(
			readFileSync(manifestPath, "utf8"),
		);
		if (apiBaseUrl) manifest.homepage_url = new URL(apiBaseUrl).origin;
		if (manifestKey) manifest.key = manifestKey;
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	},
});

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, __dirname, "");

	return {
		plugins: [react(), selfHostManifest(env)],
		build: {
			emptyOutDir: false,
			outDir: "dist",
			rollupOptions: {
				input: {
					popup: resolve(__dirname, "popup.html"),
					"popup-window": resolve(__dirname, "popup-window.html"),
					options: resolve(__dirname, "options.html"),
					welcome: resolve(__dirname, "welcome.html"),
					"how-it-works": resolve(__dirname, "how-it-works.html"),
					uploading: resolve(__dirname, "uploading.html"),
					offscreen: resolve(__dirname, "offscreen.html"),
					"camera-preview": resolve(__dirname, "camera-preview.html"),
					"camera-permission": resolve(__dirname, "camera-permission.html"),
					"service-worker": resolve(
						__dirname,
						"src/background/service-worker.ts",
					),
				},
				output: {
					entryFileNames: "assets/[name].js",
					chunkFileNames: "assets/[name].js",
					assetFileNames: "assets/[name][extname]",
				},
			},
		},
	};
});
