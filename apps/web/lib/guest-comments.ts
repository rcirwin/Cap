import { isCommentReaction } from "./comment-reactions";
import { normalizeGuestName } from "./guest-name";

export const GUEST_ID_PREFIX = "G";
export const GUEST_COMMENT_MAX_LENGTH = 2000;

// Real user ids are lowercase nanoIds, so the uppercase prefix keeps a guest id
// from ever matching a user row (comments.authorId has no foreign key).
const GUEST_ID_PATTERN = /^G[0-9a-hjkmnp-tv-z]{14}$/;
const MAX_ID_LENGTH = 64;

export const GUEST_COMMENT_LIMITS = {
	perVideo: { max: 20, windowMs: 10 * 60 * 1000 },
	global: { max: 60, windowMs: 60 * 60 * 1000 },
} as const;

export const isGuestId = (value: unknown): value is string =>
	typeof value === "string" && GUEST_ID_PATTERN.test(value);

export type GuestCommentInput = {
	videoId: string;
	type: "text" | "emoji";
	content: string;
	parentCommentId: string | null;
	timestamp: number | null;
	guestName: string;
};

export type GuestCommentValidation =
	| { ok: true; value: GuestCommentInput }
	| { ok: false; error: string };

const invalid = (error: string): GuestCommentValidation => ({
	ok: false,
	error,
});

export function validateGuestCommentInput(input: {
	videoId: unknown;
	type: unknown;
	content: unknown;
	parentCommentId: unknown;
	timestamp: unknown;
	guestName: unknown;
}): GuestCommentValidation {
	if (
		typeof input.videoId !== "string" ||
		input.videoId.length === 0 ||
		input.videoId.length > MAX_ID_LENGTH
	) {
		return invalid("Video not found");
	}

	const guestName = normalizeGuestName(input.guestName);
	if (!guestName) return invalid("Please enter your name to comment");

	if (input.type !== "text" && input.type !== "emoji") {
		return invalid("Unsupported comment type");
	}
	const type = input.type;

	if (typeof input.content !== "string") {
		return invalid("Write something before posting");
	}
	const content = input.content.trim();
	if (type === "emoji") {
		if (!isCommentReaction(content)) return invalid("Unsupported reaction");
	} else {
		if (content.length === 0) return invalid("Write something before posting");
		if (content.length > GUEST_COMMENT_MAX_LENGTH) {
			return invalid(
				`Comments can be at most ${GUEST_COMMENT_MAX_LENGTH} characters`,
			);
		}
	}

	let parentCommentId: string | null = null;
	if (input.parentCommentId !== null && input.parentCommentId !== undefined) {
		if (
			typeof input.parentCommentId !== "string" ||
			input.parentCommentId.length > MAX_ID_LENGTH
		) {
			return invalid("That comment no longer exists");
		}
		parentCommentId =
			input.parentCommentId.length > 0 ? input.parentCommentId : null;
	}
	if (parentCommentId && type !== "text") {
		return invalid("Only text comments can be replies");
	}

	let timestamp: number | null = null;
	if (input.timestamp !== null && input.timestamp !== undefined) {
		if (
			typeof input.timestamp !== "number" ||
			!Number.isFinite(input.timestamp) ||
			input.timestamp < 0
		) {
			return invalid("Invalid video timestamp");
		}
		timestamp = input.timestamp;
	}

	return {
		ok: true,
		value: {
			videoId: input.videoId,
			type,
			content,
			parentCommentId,
			timestamp,
			guestName,
		},
	};
}

export const GUEST_COMMENT_THROTTLED_ERROR =
	"You're commenting too quickly. Please wait a few minutes and try again.";

export function decideGuestCommentThrottle(recent: {
	perVideo: number;
	global: number;
}): { allowed: true } | { allowed: false; error: string } {
	if (
		recent.perVideo >= GUEST_COMMENT_LIMITS.perVideo.max ||
		recent.global >= GUEST_COMMENT_LIMITS.global.max
	) {
		return { allowed: false, error: GUEST_COMMENT_THROTTLED_ERROR };
	}
	return { allowed: true };
}

export function getClientIp(headers: {
	get(name: string): string | null;
}): string | null {
	const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
	if (forwarded) return forwarded;
	const realIp = headers.get("x-real-ip")?.trim();
	return realIp ? realIp : null;
}

export type CommentActor =
	| { kind: "user"; id: string }
	| { kind: "guest"; id: string };

export function canDeleteComment({
	actor,
	authorId,
	videoOwnerId,
}: {
	actor: CommentActor;
	authorId: string;
	videoOwnerId: string | null;
}): boolean {
	if (actor.id === authorId) return true;
	return (
		actor.kind === "user" && videoOwnerId !== null && actor.id === videoOwnerId
	);
}
