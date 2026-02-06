/**
 * Tests for chrome.ts — profile discovery, cookie import, CDP detection,
 * and Chrome launch/restart orchestration.
 *
 * Tests that hit the filesystem use temp dirs. Tests that would launch Chrome
 * or hit the network are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ─── Profile Discovery ─────────────────────────────────────────────────────

describe("discoverProfiles", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// Lazy import so mocks can be set up first if needed
	async function getDiscoverProfiles() {
		const mod = await import("../chrome.js");
		return mod.discoverProfiles;
	}

	it("returns empty array for non-existent directory", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		const result = discoverProfiles("/nonexistent/path/chrome");
		expect(result).toEqual([]);
	});

	it("returns empty array for empty directory", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		const result = discoverProfiles(tempDir);
		expect(result).toEqual([]);
	});

	it("discovers Default profile with display name and email", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		const defaultDir = join(tempDir, "Default");
		mkdirSync(defaultDir);
		writeFileSync(join(defaultDir, "Preferences"), JSON.stringify({
			profile: { name: "Personal" },
			account_info: [{ email: "user@example.com" }],
		}));

		const profiles = discoverProfiles(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0]).toMatchObject({
			dirName: "Default",
			displayName: "Personal",
			email: "user@example.com",
		});
		expect(profiles[0].path).toBe(defaultDir);
	});

	it("discovers numbered profiles", async () => {
		const discoverProfiles = await getDiscoverProfiles();

		for (const [dir, name, email] of [
			["Profile 1", "Work", "work@company.com"],
			["Profile 2", "Side Project", ""],
		] as const) {
			const profileDir = join(tempDir, dir);
			mkdirSync(profileDir);
			const prefs: any = { profile: { name } };
			if (email) prefs.account_info = [{ email }];
			writeFileSync(join(profileDir, "Preferences"), JSON.stringify(prefs));
		}

		const profiles = discoverProfiles(tempDir);
		expect(profiles).toHaveLength(2);
		// Sorted alphabetically by display name
		expect(profiles[0].displayName).toBe("Side Project");
		expect(profiles[0].email).toBeUndefined();
		expect(profiles[1].displayName).toBe("Work");
		expect(profiles[1].email).toBe("work@company.com");
	});

	it("sorts Default first, then alphabetically by display name", async () => {
		const discoverProfiles = await getDiscoverProfiles();

		for (const [dir, name] of [
			["Profile 1", "Zebra"],
			["Default", "Main"],
			["Profile 2", "Alpha"],
		] as const) {
			mkdirSync(join(tempDir, dir));
			writeFileSync(join(tempDir, dir, "Preferences"), JSON.stringify({
				profile: { name },
			}));
		}

		const profiles = discoverProfiles(tempDir);
		expect(profiles.map(p => p.displayName)).toEqual(["Main", "Alpha", "Zebra"]);
	});

	it("handles corrupted Preferences gracefully", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		const profileDir = join(tempDir, "Default");
		mkdirSync(profileDir);
		writeFileSync(join(profileDir, "Preferences"), "not json{{{");

		const profiles = discoverProfiles(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].dirName).toBe("Default");
		expect(profiles[0].displayName).toBe("Default"); // falls back to dir name
	});

	it("skips directories without Preferences file", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		mkdirSync(join(tempDir, "Default"));
		// No Preferences file
		mkdirSync(join(tempDir, "Profile 1"));
		writeFileSync(join(tempDir, "Profile 1", "Preferences"), JSON.stringify({
			profile: { name: "Work" },
		}));

		const profiles = discoverProfiles(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].dirName).toBe("Profile 1");
	});

	it("ignores non-profile directories", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		mkdirSync(join(tempDir, "CrashpadMetrics"));
		mkdirSync(join(tempDir, "GrShaderCache"));
		mkdirSync(join(tempDir, "SafeBrowsing"));
		mkdirSync(join(tempDir, "Default"));
		writeFileSync(join(tempDir, "Default", "Preferences"), JSON.stringify({
			profile: { name: "Me" },
		}));

		const profiles = discoverProfiles(tempDir);
		expect(profiles).toHaveLength(1);
		expect(profiles[0].dirName).toBe("Default");
	});

	it("reads email from google.services.signin fallback", async () => {
		const discoverProfiles = await getDiscoverProfiles();
		mkdirSync(join(tempDir, "Default"));
		writeFileSync(join(tempDir, "Default", "Preferences"), JSON.stringify({
			profile: { name: "Work" },
			google: { services: { signin: { email: "fallback@example.com" } } },
		}));

		const profiles = discoverProfiles(tempDir);
		expect(profiles[0].email).toBe("fallback@example.com");
	});
});

// ─── Cookie Import ──────────────────────────────────────────────────────────

describe("importCookiesFromProfile", () => {
	let srcDir: string;
	const piBrowserDataDir = join(homedir(), ".pi", "browser-data", "Default");

	beforeEach(() => {
		srcDir = mkdtempSync(join(tmpdir(), "pi-chrome-src-"));
		// Clean the destination so previous runs don't interfere
		for (const file of ["Cookies", "Cookies-journal", "Login Data", "Login Data-journal"]) {
			const dest = join(piBrowserDataDir, file);
			if (existsSync(dest)) rmSync(dest);
		}
	});

	afterEach(() => {
		rmSync(srcDir, { recursive: true, force: true });
		// Clean up what we wrote
		for (const file of ["Cookies", "Cookies-journal", "Login Data", "Login Data-journal"]) {
			const dest = join(piBrowserDataDir, file);
			if (existsSync(dest)) rmSync(dest);
		}
	});

	async function getImportCookies() {
		const mod = await import("../chrome.js");
		return mod.importCookiesFromProfile;
	}

	it("copies Cookies and Login Data files", async () => {
		const importCookiesFromProfile = await getImportCookies();

		const profileDir = join(srcDir, "Profile 1");
		mkdirSync(profileDir);
		writeFileSync(join(profileDir, "Cookies"), "cookie-data");
		writeFileSync(join(profileDir, "Cookies-journal"), "cookie-journal");
		writeFileSync(join(profileDir, "Login Data"), "login-data");
		writeFileSync(join(profileDir, "Login Data-journal"), "login-journal");

		const result = importCookiesFromProfile("Profile 1", srcDir);

		expect(result.imported).toContain("Cookies");
		expect(result.imported).toContain("Login Data");
		expect(result.imported).toContain("Cookies-journal");
		expect(result.imported).toContain("Login Data-journal");

		// Verify files actually exist at destination
		expect(existsSync(join(piBrowserDataDir, "Cookies"))).toBe(true);
		expect(readFileSync(join(piBrowserDataDir, "Cookies"), "utf-8")).toBe("cookie-data");
	});

	it("throws if profile directory doesn't exist", async () => {
		const importCookiesFromProfile = await getImportCookies();
		expect(() => importCookiesFromProfile("NonExistent", srcDir)).toThrow(
			/Chrome profile "NonExistent" not found/
		);
	});

	it("skips files that already exist in destination (no overwrite)", async () => {
		const importCookiesFromProfile = await getImportCookies();

		const profileDir = join(srcDir, "Default");
		mkdirSync(profileDir);
		writeFileSync(join(profileDir, "Cookies"), "new-cookies");

		// First import
		const result1 = importCookiesFromProfile("Default", srcDir);
		expect(result1.imported).toContain("Cookies");

		// Second call should not overwrite
		writeFileSync(join(profileDir, "Cookies"), "even-newer-cookies");
		const result2 = importCookiesFromProfile("Default", srcDir);
		expect(result2.imported).not.toContain("Cookies");

		// Original data preserved
		expect(readFileSync(join(piBrowserDataDir, "Cookies"), "utf-8")).toBe("new-cookies");
	});

	it("returns empty imported array when no files exist in source", async () => {
		const importCookiesFromProfile = await getImportCookies();

		const profileDir = join(srcDir, "Default");
		mkdirSync(profileDir);

		const result = importCookiesFromProfile("Default", srcDir);
		expect(result.imported).toEqual([]);
	});
});

// ─── CDP Detection ──────────────────────────────────────────────────────────

describe("isDebugPortOpen", () => {
	async function getIsDebugPortOpen() {
		const mod = await import("../chrome.js");
		return mod.isDebugPortOpen;
	}

	it("returns false for a port with nothing listening", async () => {
		const isDebugPortOpen = await getIsDebugPortOpen();
		// Use a random high port that's almost certainly not in use
		const result = await isDebugPortOpen(19999);
		expect(result).toBe(false);
	});
});

describe("getCdpInfo", () => {
	async function getGetCdpInfo() {
		const mod = await import("../chrome.js");
		return mod.getCdpInfo;
	}

	it("returns null for a port with nothing listening", async () => {
		const getCdpInfo = await getGetCdpInfo();
		const result = await getCdpInfo(19999);
		expect(result).toBeNull();
	});
});

// ─── waitForCdp ─────────────────────────────────────────────────────────────

describe("waitForCdp", () => {
	async function getWaitForCdp() {
		const mod = await import("../chrome.js");
		return mod.waitForCdp;
	}

	it("returns false quickly when port never opens (short timeout)", async () => {
		const waitForCdp = await getWaitForCdp();
		const start = Date.now();
		const result = await waitForCdp(19999, 1500);
		const elapsed = Date.now() - start;
		expect(result).toBe(false);
		expect(elapsed).toBeLessThan(3000);
		expect(elapsed).toBeGreaterThanOrEqual(1000); // should poll for ~1.5s
	});
});

// ─── detectChrome ───────────────────────────────────────────────────────────

describe("detectChrome", () => {
	async function getDetectChrome() {
		const mod = await import("../chrome.js");
		return mod.detectChrome;
	}

	it("returns a ChromeInfo object with all required fields", async () => {
		const detectChrome = await getDetectChrome();
		const info = await detectChrome(19999); // port nobody listens on

		expect(info).toHaveProperty("binary");
		expect(info).toHaveProperty("userDataDir");
		expect(info).toHaveProperty("profiles");
		expect(info).toHaveProperty("running");
		expect(info).toHaveProperty("debugPortOpen");
		expect(info).toHaveProperty("cdpPort");

		expect(Array.isArray(info.profiles)).toBe(true);
		expect(typeof info.running).toBe("boolean");
		expect(info.debugPortOpen).toBe(false); // port 19999 not open
		expect(info.cdpPort).toBe(19999);
	});
});

// ─── ensureChromeWithCdp orchestration ──────────────────────────────────────

describe("ensureChromeWithCdp", () => {
	it("returns immediately if CDP port is already open", async () => {
		// Mock isDebugPortOpen to return true
		vi.doMock("../chrome.js", async (importOriginal) => {
			const original = await importOriginal<typeof import("../chrome.js")>();
			return {
				...original,
				isDebugPortOpen: vi.fn().mockResolvedValue(true),
			};
		});

		const { ensureChromeWithCdp } = await import("../chrome.js");
		const result = await ensureChromeWithCdp({ port: 9222 });

		expect(result).toEqual({ port: 9222, restarted: false, launched: false });

		vi.doUnmock("../chrome.js");
	});
});
