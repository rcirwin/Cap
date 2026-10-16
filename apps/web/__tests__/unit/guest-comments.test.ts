import { describe, expect, it } from "vitest";
import {
	canDeleteComment,
	decideGuestCommentThrottle,
	GUEST_COMMENT_LIMITS,
	GUEST_COMMENT_MAX_LENGTH,
	GUEST_COMMENT_THROTTLED_ERROR,
	getClientIp,
	validateGuestCommentInput,
} from "@/lib/guest-comments";

const validInput = {
	videoId: "abcdefghjkmnpqr",
	type: "text",
	content: "  Looks great  ",
	parentCommentId: "",
	timestamp: 12.5,
	guestName: "  Ada   Lovelace ",
};

describe("validateGuestCommentInput", () => {
	it("normalizes a valid text comment", () => {
		expect(validateGuestCommentInput(validInput)).toEqual({
			ok: true,
			value: {
				videoId: "abcdefghjkmnpqr",
				type: "text",
				content: "Looks great",
				parentCommentId: null,
				timestamp: 12.5,
				guestName: "Ada Lovelace",
			},
		});
	});

	it("requires a display name", () => {
		for (const guestName of ["", "   ", null, 42, "\u0000\u0007"]) {
			expect(validateGuestCommentInput({ ...validInput, guestName })).toEqual({
				ok: false,
				error: "Please enter your name to comment",
			});
		}
	});

	it("truncates long names to the column width", () => {
		const result = validateGuestCommentInput({
			...validInput,
			guestName: "x".repeat(200),
		});
		expect(result.ok && result.value.guestName).toHaveLength(64);
	});

	it("bounds text content after trimming", () => {
		expect(
			validateGuestCommentInput({ ...validInput, content: "   " }).ok,
		).toBe(false);
		expect(
			validateGuestCommentInput({
				...validInput,
				content: "a".repeat(GUEST_COMMENT_MAX_LENGTH),
			}).ok,
		).toBe(true);
		expect(
			validateGuestCommentInput({
				...validInput,
				content: "a".repeat(GUEST_COMMENT_MAX_LENGTH + 1),
			}),
		).toEqual({
			ok: false,
			error: `Comments can be at most ${GUEST_COMMENT_MAX_LENGTH} characters`,
		});
		expect(validateGuestCommentInput({ ...validInput, content: 123 }).ok).toBe(
			false,
		);
	});

	it("only accepts the share page's reactions", () => {
		expect(
			validateGuestCommentInput({
				...validInput,
				type: "emoji",
				content: "👍",
			}).ok,
		).toBe(true);
		for (const content of ["💩", "👍👍", "nice", ""]) {
			expect(
				validateGuestCommentInput({ ...validInput, type: "emoji", content }),
			).toEqual({ ok: false, error: "Unsupported reaction" });
		}
	});

	it("rejects other comment types", () => {
		for (const type of ["video", "audio", undefined]) {
			expect(validateGuestCommentInput({ ...validInput, type }).ok).toBe(false);
		}
	});

	it("keeps replies to text and treats empty parents as top level", () => {
		const reply = validateGuestCommentInput({
			...validInput,
			parentCommentId: "parentcomment01",
		});
		expect(reply.ok && reply.value.parentCommentId).toBe("parentcomment01");
		expect(
			validateGuestCommentInput({ ...validInput, parentCommentId: null }).ok,
		).toBe(true);
		expect(
			validateGuestCommentInput({
				...validInput,
				type: "emoji",
				content: "👍",
				parentCommentId: "parentcomment01",
			}),
		).toEqual({ ok: false, error: "Only text comments can be replies" });
		expect(
			validateGuestCommentInput({
				...validInput,
				parentCommentId: "p".repeat(65),
			}).ok,
		).toBe(false);
	});

	it("accepts a null or finite non-negative timestamp", () => {
		expect(
			validateGuestCommentInput({ ...validInput, timestamp: null }).ok,
		).toBe(true);
		expect(validateGuestCommentInput({ ...validInput, timestamp: 0 }).ok).toBe(
			true,
		);
		for (const timestamp of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3"]) {
			expect(validateGuestCommentInput({ ...validInput, timestamp })).toEqual({
				ok: false,
				error: "Invalid video timestamp",
			});
		}
	});

	it("rejects a missing video id", () => {
		expect(validateGuestCommentInput({ ...validInput, videoId: "" })).toEqual({
			ok: false,
			error: "Video not found",
		});
	});
});

describe("decideGuestCommentThrottle", () => {
	it("allows guests under both limits", () => {
		expect(
			decideGuestCommentThrottle({
				perVideo: GUEST_COMMENT_LIMITS.perVideo.max - 1,
				global: GUEST_COMMENT_LIMITS.global.max - 1,
			}),
		).toEqual({ allowed: true });
	});

	it("blocks at the per-video limit", () => {
		expect(
			decideGuestCommentThrottle({
				perVideo: GUEST_COMMENT_LIMITS.perVideo.max,
				global: 0,
			}),
		).toEqual({ allowed: false, error: GUEST_COMMENT_THROTTLED_ERROR });
	});

	it("blocks at the cross-video limit", () => {
		expect(
			decideGuestCommentThrottle({
				perVideo: 0,
				global: GUEST_COMMENT_LIMITS.global.max,
			}),
		).toEqual({ allowed: false, error: GUEST_COMMENT_THROTTLED_ERROR });
	});

	it("uses 20 per video per 10 minutes and 60 overall per hour", () => {
		expect(GUEST_COMMENT_LIMITS).toEqual({
			perVideo: { max: 20, windowMs: 600_000 },
			global: { max: 60, windowMs: 3_600_000 },
		});
	});
});

describe("getClientIp", () => {
	it("prefers the first X-Forwarded-For entry", () => {
		expect(
			getClientIp(
				new Headers({
					"x-forwarded-for": " 203.0.113.4 , 10.0.0.1",
					"x-real-ip": "10.0.0.9",
				}),
			),
		).toBe("203.0.113.4");
	});

	it("falls back to X-Real-IP, then null", () => {
		expect(getClientIp(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe(
			"198.51.100.2",
		);
		expect(getClientIp(new Headers({ "x-forwarded-for": " , " }))).toBeNull();
		expect(getClientIp(new Headers())).toBeNull();
	});
});

describe("canDeleteComment", () => {
	const guest = { kind: "guest", id: "Gabcdefghjkmnpq" } as const;
	const owner = { kind: "user", id: "owner0000000001" } as const;
	const viewer = { kind: "user", id: "viewer000000001" } as const;

	it("lets authors delete their own comments", () => {
		expect(
			canDeleteComment({
				actor: guest,
				authorId: guest.id,
				videoOwnerId: owner.id,
			}),
		).toBe(true);
		expect(
			canDeleteComment({
				actor: viewer,
				authorId: viewer.id,
				videoOwnerId: owner.id,
			}),
		).toBe(true);
	});

	it("lets the video owner moderate anyone's comment", () => {
		expect(
			canDeleteComment({
				actor: owner,
				authorId: guest.id,
				videoOwnerId: owner.id,
			}),
		).toBe(true);
	});

	it("denies everyone else", () => {
		expect(
			canDeleteComment({
				actor: viewer,
				authorId: guest.id,
				videoOwnerId: owner.id,
			}),
		).toBe(false);
		expect(
			canDeleteComment({
				actor: guest,
				authorId: viewer.id,
				videoOwnerId: owner.id,
			}),
		).toBe(false);
		expect(
			canDeleteComment({
				actor: { kind: "guest", id: owner.id },
				authorId: viewer.id,
				videoOwnerId: owner.id,
			}),
		).toBe(false);
		expect(
			canDeleteComment({
				actor: owner,
				authorId: guest.id,
				videoOwnerId: null,
			}),
		).toBe(false);
	});
});
