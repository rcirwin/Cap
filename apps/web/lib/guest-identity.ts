import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { nanoId } from "@cap/database/helpers";
import { serverEnv } from "@cap/env";
import { cookies } from "next/headers";
import { GUEST_ID_PREFIX, isGuestId } from "./guest-comments";

const GUEST_COOKIE_NAME = "cap_guest";
const GUEST_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

// Domain separator so a guest identity signature can never be replayed as any
// other HMAC this app derives from NEXTAUTH_SECRET.
const TOKEN_DOMAIN = "guest-comment-identity:";

const sign = (guestId: string) =>
	createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(TOKEN_DOMAIN + guestId)
		.digest("base64url");

export const createGuestId = () => `${GUEST_ID_PREFIX}${nanoId().slice(1)}`;

export const createGuestToken = (guestId: string) =>
	`${guestId}.${sign(guestId)}`;

export function verifyGuestToken(
	token: string | null | undefined,
): string | null {
	if (!token) return null;
	const separator = token.indexOf(".");
	if (separator <= 0) return null;

	const guestId = token.slice(0, separator);
	const signature = token.slice(separator + 1);
	if (!isGuestId(guestId) || signature.length === 0) return null;

	const expected = Buffer.from(sign(guestId));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length) return null;
	if (!timingSafeEqual(expected, actual)) return null;
	return guestId;
}

export const hashGuestIp = (ip: string) =>
	createHash("sha256")
		.update(`${ip}${serverEnv().NEXTAUTH_SECRET}`)
		.digest("hex");

export async function readGuestId(): Promise<string | null> {
	return verifyGuestToken((await cookies()).get(GUEST_COOKIE_NAME)?.value);
}

export async function ensureGuestId(): Promise<string> {
	const guestId = (await readGuestId()) ?? createGuestId();
	(await cookies()).set(GUEST_COOKIE_NAME, createGuestToken(guestId), {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
		maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
	});
	return guestId;
}
