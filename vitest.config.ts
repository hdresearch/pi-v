import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const piPath = "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent";

export default defineConfig({
	resolve: {
		alias: {
			"@sinclair/typebox": resolve(piPath, "node_modules/@sinclair/typebox"),
			"@mariozechner/pi-coding-agent": piPath,
		},
	},
	test: {
		include: ["**/__tests__/**/*.test.ts"],
	},
});
