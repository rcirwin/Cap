import { createHash } from "node:crypto";
import { Context, Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
	guestCommentsEnabled: true,
	user: null as { id: string } | null,
	videoPublic: true,
	videoRows: [] as Row[],
	recentGuestComments: [] as Row[],
	inserted: [] as Row[],
	cookies: new Map<string, { value: string; options: unknown }>(),
	canView: vi.fn(),
	notify: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_GUEST_COMMENTS: mocks.guestCommentsEnabled,
		NEXTAUTH_SECRET: "test-secret",
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: (selection: Row) => {
			const result =
				"videoSettings" in selection
					? mocks.videoRows
					: mocks.recentGuestComments;
			const query = {
				from: () => query,
				leftJoin: () => query,
				where: () => query,
				limit: async () => result,
			};
			return query;
		},
		insert: () => ({
			values: async (row: Row) => {
				mocks.inserted.push(row);
			},
		}),
	}),
}));

vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	const rules = await import(
		"../../../../packages/web-backend/src/Videos/EffectiveVideoRules"
	);
	return {
		VideosPolicy: Context.GenericTag("GuestCommentTestPolicy"),
		provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		resolveEffectiveVideoRules: rules.resolveEffectiveVideoRules,
	};
});

vi.mock("@/lib/server", () => ({
	runPromiseExit: <A, E>(effect: Effect.Effect<A, E, unknown>) =>
		Effect.runPromiseExit(
			effect.pipe(
				Effect.provideService(Context.GenericTag("GuestCommentTestPolicy"), {
					canView: mocks.canView,
				}),
			) as Effect.Effect<A, E, never>,
		),
}));

vi.mock("@/lib/video-shared-spaces", () => ({
	getSharedSpacesForVideo: async () => ({
		sharedSpaces: [],
		sharedOrganizations: [],
	}),
	ruleSpacesFromSharedSpaces: (spaces: unknown[]) => spaces,
}));

vi.mock("@/lib/Notification", () => ({ createNotification: mocks.notify }));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("next/headers", () => ({
	headers: async () =>
		new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" }),
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

import { Comment, Policy, Video } from "@cap/web-domain";
import { newGuestComment } from "@/actions/videos/new-guest-comment";
import { verifyGuestToken } from "@/lib/guest-identity";

const videoId = Video.VideoId.make("abcdefghjkmnpqr");

const commentInput = {
	videoId,
	type: "text" as const,
	content: "  Love the new flow  ",
	parentCommentId: Comment.CommentId.make(""),
	timestamp: 4.2,
	guestName: " Ada ",
};

describe("newGuestComment", () => {
	beforeEach(() => {
		mocks.guestCommentsEnabled = true;
		mocks.user = null;
		mocks.videoPublic = true;
		mocks.videoRows = [
			{
				id: videoId,
				videoSettings: null,
				orgSettings: null,
				organizationTombstoneAt: null,
			},
		];
		mocks.recentGuestComments = [];
		mocks.inserted = [];
		mocks.cookies.clear();
		mocks.notify.mockResolvedValue({ success: true });
		mocks.canView.mockImplementation(() =>
			Policy.publicPolicy((user) =>
				Effect.sync(() => {
					if (mocks.videoPublic) return true;
					return Option.isSome(user);
				}),
			),
		);
	});

	it("posts a guest comment, issues an identity cookie and notifies the owner", async () => {
		const result = await newGuestComment(commentInput);

		expect(result.success).toBe(true);
		if (!result.success) return;

		const cookie = mocks.cookies.get("cap_guest");
		expect(verifyGuestToken(cookie?.value)).toBe(result.guestId);
		expect(cookie?.options).toMatchObject({
			httpOnly: true,
			sameSite: "lax",
			path: "/",
		});
		expect(result.guestId).toMatch(/^G[0-9a-z]{14}$/);

		expect(mocks.inserted).toHaveLength(1);
		expect(mocks.inserted[0]).toMatchObject({
			id: result.comment.id,
			authorId: result.guestId,
			type: "text",
			content: "Love the new flow",
			videoId,
			timestamp: 4.2,
			parentCommentId: "",
			guestName: "Ada",
			guestIpHash: createHash("sha256")
				.update("203.0.113.7test-secret")
				.digest("hex"),
		});

		expect(result.comment).toMatchObject({
			authorId: result.guestId,
			authorName: "Ada",
			authorImage: null,
			guestName: "Ada",
			content: "Love the new flow",
			sending: false,
		});
		expect(result.comment).not.toHaveProperty("guestIpHash");

		expect(mocks.notify).toHaveBeenCalledExactlyOnceWith({
			type: "comment",
			videoId,
			authorId: result.guestId,
			comment: { id: result.comment.id, content: "Love the new flow" },
			parentCommentId: undefined,
			guestName: "Ada",
		});
		expect(mocks.revalidatePath).toHaveBeenCalledWith(`/s/${videoId}`);
	});

	it("reuses the guest identity across comments", async () => {
		const first = await newGuestComment(commentInput);
		const second = await newGuestComment({
			...commentInput,
			type: "emoji",
			content: "🙌",
		});
		expect(first.success && second.success).toBe(true);
		if (!first.success || !second.success) return;
		expect(second.guestId).toBe(first.guestId);
		expect(mocks.notify).toHaveBeenLastCalledWith(
			expect.objectContaining({ type: "reaction" }),
		);
	});

	it("does nothing while guest comments are turned off", async () => {
		mocks.guestCommentsEnabled = false;
		const result = await newGuestComment(commentInput);

		expect(result).toEqual({
			success: false,
			error: "Guest comments are turned off",
		});
		expect(mocks.canView).not.toHaveBeenCalled();
		expect(mocks.inserted).toHaveLength(0);
		expect(mocks.cookies.size).toBe(0);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("denies private videos to signed-out guests", async () => {
		mocks.videoPublic = false;
		const result = await newGuestComment(commentInput);

		expect(result).toEqual({ success: false, error: "Video not found" });
		expect(mocks.canView).toHaveBeenCalledWith(videoId);
		expect(mocks.inserted).toHaveLength(0);
		expect(mocks.cookies.size).toBe(0);
		expect(mocks.notify).not.toHaveBeenCalled();
	});

	it("keeps signed-in viewers on the account flow", async () => {
		mocks.user = { id: "user-1" };
		const result = await newGuestComment(commentInput);
		expect(result.success).toBe(false);
		expect(mocks.inserted).toHaveLength(0);
	});

	it("respects the video's comment and reaction rules", async () => {
		mocks.videoRows = [
			{
				id: videoId,
				videoSettings: { disableReactions: true },
				orgSettings: { disableComments: true },
				organizationTombstoneAt: null,
			},
		];

		expect(await newGuestComment(commentInput)).toEqual({
			success: false,
			error: "Comments are turned off for this video",
		});
		expect(
			await newGuestComment({ ...commentInput, type: "emoji", content: "👍" }),
		).toEqual({
			success: false,
			error: "Reactions are turned off for this video",
		});
		expect(mocks.inserted).toHaveLength(0);
	});

	it("throttles guests that post too often", async () => {
		mocks.recentGuestComments = Array.from({ length: 20 }, (_, index) => ({
			id: `recent-${index}`,
		}));
		const result = await newGuestComment(commentInput);
		expect(result.success).toBe(false);
		expect(mocks.inserted).toHaveLength(0);
	});

	it("rejects invalid input before touching the database", async () => {
		const result = await newGuestComment({ ...commentInput, guestName: " " });
		expect(result).toEqual({
			success: false,
			error: "Please enter your name to comment",
		});
		expect(mocks.canView).not.toHaveBeenCalled();
	});
});
