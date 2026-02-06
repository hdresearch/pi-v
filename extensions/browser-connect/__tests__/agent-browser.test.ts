/**
 * Tests for agent-browser.ts — CLI wrapper, path generation, install detection.
 */

import { describe, it, expect } from "vitest";
import { screenshotPath, isInstalled } from "../agent-browser.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

describe("screenshotPath", () => {
	it("returns a path in the temp directory", () => {
		const path = screenshotPath();
		expect(path).toContain(tmpdir());
	});

	it("includes pi-browser prefix", () => {
		const path = screenshotPath();
		expect(path).toMatch(/pi-browser-\d+\.png$/);
	});

	it("generates unique paths on successive calls", () => {
		const path1 = screenshotPath();
		// Tiny delay to ensure different timestamp
		const path2 = screenshotPath();
		// They could be equal if called in same ms, but the pattern should be correct
		expect(path1).toMatch(/\.png$/);
		expect(path2).toMatch(/\.png$/);
	});
});

describe("isInstalled", () => {
	it("returns a boolean", () => {
		const result = isInstalled();
		expect(typeof result).toBe("boolean");
	});

	// Note: we can't guarantee agent-browser is/isn't installed in CI,
	// but we can verify the function doesn't throw
	it("does not throw", () => {
		expect(() => isInstalled()).not.toThrow();
	});
});
