import { isEmailAllowedForSignup } from "@cap/database/auth/domain-utils";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

describe("isEmailAllowedForSignup", () => {
	it("allows everyone when no allowlist is configured", () => {
		expect(isEmailAllowedForSignup("anyone@example.com", undefined)).toBe(true);
		expect(isEmailAllowedForSignup("anyone@example.com", "  ")).toBe(true);
	});

	it("matches allowed domains case-insensitively", () => {
		expect(isEmailAllowedForSignup("Me@Example.com", "example.com")).toBe(true);
		expect(isEmailAllowedForSignup("me@other.com", "example.com")).toBe(false);
	});

	it("allows exact email entries without opening the whole domain", () => {
		const allowlist = "owner@gmail.com";
		expect(isEmailAllowedForSignup("Owner@Gmail.com", allowlist)).toBe(true);
		expect(isEmailAllowedForSignup("stranger@gmail.com", allowlist)).toBe(
			false,
		);
	});

	it("supports mixing domains and exact emails", () => {
		const allowlist = "example.com, owner@gmail.com";
		expect(isEmailAllowedForSignup("team@example.com", allowlist)).toBe(true);
		expect(isEmailAllowedForSignup("owner@gmail.com", allowlist)).toBe(true);
		expect(isEmailAllowedForSignup("other@gmail.com", allowlist)).toBe(false);
	});

	it("rejects malformed emails even when listed", () => {
		expect(isEmailAllowedForSignup("not-an-email", "not-an-email")).toBe(false);
	});
});
