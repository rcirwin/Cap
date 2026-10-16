import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	secret: "test-secret",
	cookies: new Map<string, { value: string; options: unknown }>(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: mocks.secret }),
}));

vi.mock("next/headers", () => ({
	cookies: async () => ({
		get: (name: string) => {
			const cookie = mocks.cookies.get(name);
			return cookie ? { name, value: cookie.value } : undefined;
		},
		set: (name: string, value: string, options: unknown) => {
			mocks.cookies.set(name, { value, options });
		},
	}),
}));

import { isGuestId } from "@/lib/guest-comments";
import {
	createGuestId,
	createGuestToken,
	ensureGuestId,
	hashGuestIp,
	readGuestId,
	verifyGuestToken,
} from "@/lib/guest-identity";

describe("guest identity token", () => {
	beforeEach(() => {
		mocks.secret = "test-secret";
		mocks.cookies.clear();
	});

	it("issues ids that cannot collide with lowercase user ids", () => {
		const guestId = createGuestId();
		expect(guestId).toHaveLength(15);
		expect(guestId.startsWith("G")).toBe(true);
		expect(isGuestId(guestId)).toBe(true);
		expect(isGuestId("abcdefghjkmnpqr")).toBe(false);
	});

	it("round-trips a signed guest id", () => {
		const guestId = createGuestId();
		expect(verifyGuestToken(createGuestToken(guestId))).toBe(guestId);
	});

	it("rejects a token whose guest id was swapped", () => {
		const [, signature] = createGuestToken(createGuestId()).split(".");
		const forged = `${createGuestId()}.${signature}`;
		expect(verifyGuestToken(forged)).toBeNull();
	});

	it("rejects a tampered signature", () => {
		const token = createGuestToken(createGuestId());
		const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
		expect(verifyGuestToken(flipped)).toBeNull();
	});

	it("rejects tokens signed with another secret", () => {
		const token = createGuestToken(createGuestId());
		mocks.secret = "rotated-secret";
		expect(verifyGuestToken(token)).toBeNull();
	});

	it("rejects signed values that are not guest ids", () => {
		const userLikeId = "abcdefghjkmnpqr";
		expect(verifyGuestToken(createGuestToken(userLikeId))).toBeNull();
	});

	it("rejects garbage", () => {
		expect(verifyGuestToken(undefined)).toBeNull();
		expect(verifyGuestToken("")).toBeNull();
		expect(verifyGuestToken("abc")).toBeNull();
		expect(verifyGuestToken(".sig")).toBeNull();
		expect(verifyGuestToken(`${createGuestId()}.`)).toBeNull();
	});

	it("hashes the client ip with the server secret", () => {
		const hash = hashGuestIp("203.0.113.9");
		expect(hash).toBe(
			createHash("sha256").update("203.0.113.9test-secret").digest("hex"),
		);
		expect(hash).toHaveLength(64);
		expect(hashGuestIp("203.0.113.10")).not.toBe(hash);
	});

	it("persists one guest id in a locked-down cookie and reuses it", async () => {
		expect(await readGuestId()).toBeNull();

		const first = await ensureGuestId();
		const cookie = mocks.cookies.get("cap_guest");
		expect(cookie?.value).toBe(createGuestToken(first));
		expect(cookie?.options).toMatchObject({
			httpOnly: true,
			sameSite: "lax",
			path: "/",
			maxAge: 365 * 24 * 60 * 60,
		});

		expect(await readGuestId()).toBe(first);
		expect(await ensureGuestId()).toBe(first);
	});

	it("replaces a forged cookie with a fresh identity", async () => {
		mocks.cookies.set("cap_guest", {
			value: `${createGuestId()}.forged`,
			options: {},
		});
		expect(await readGuestId()).toBeNull();
		const guestId = await ensureGuestId();
		expect(verifyGuestToken(mocks.cookies.get("cap_guest")?.value)).toBe(
			guestId,
		);
	});
});
