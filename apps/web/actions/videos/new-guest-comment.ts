"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { comments, organizations, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import {
	provideOptionalAuth,
	resolveEffectiveVideoRules,
	VideosPolicy,
} from "@cap/web-backend";
import { Comment, Policy, User, Video } from "@cap/web-domain";
import { and, eq, gt } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
	decideGuestCommentThrottle,
	GUEST_COMMENT_LIMITS,
	getClientIp,
	validateGuestCommentInput,
} from "@/lib/guest-comments";
import { ensureGuestId, hashGuestIp } from "@/lib/guest-identity";
import { createNotification } from "@/lib/Notification";
import * as EffectRuntime from "@/lib/server";
import {
	getSharedSpacesForVideo,
	ruleSpacesFromSharedSpaces,
} from "@/lib/video-shared-spaces";

export type GuestComment = {
	id: Comment.CommentId;
	authorId: User.UserId;
	type: "text" | "emoji";
	content: string;
	videoId: Video.VideoId;
	timestamp: number | null;
	parentCommentId: Comment.CommentId;
	mediaKey: null;
	mediaDuration: null;
	mediaMeta: null;
	guestName: string;
	createdAt: Date;
	updatedAt: Date;
	authorName: string;
	authorImage: null;
	sending: false;
};

export type NewGuestCommentResult =
	| { success: true; comment: GuestComment; guestId: User.UserId }
	| { success: false; error: string };

const failure = (error: string): NewGuestCommentResult => ({
	success: false,
	error,
});

export async function newGuestComment(input: {
	videoId: Video.VideoId;
	type: "text" | "emoji";
	content: string;
	parentCommentId: Comment.CommentId | null;
	timestamp: number | null;
	guestName: string;
}): Promise<NewGuestCommentResult> {
	try {
		if (!serverEnv().CAP_GUEST_COMMENTS) {
			return failure("Guest comments are turned off");
		}

		if (await getCurrentUser()) {
			return failure("You're signed in. Refresh the page to comment.");
		}

		const validation = validateGuestCommentInput(input);
		if (!validation.ok) return failure(validation.error);
		const { type, content, timestamp, guestName } = validation.value;
		const videoId = Video.VideoId.make(validation.value.videoId);
		const parentCommentId = validation.value.parentCommentId
			? Comment.CommentId.make(validation.value.parentCommentId)
			: null;

		// canView grants a nonexistent videoId by design, so the row itself (not
		// just the policy) decides whether there is anything to comment on.
		const accessExit = await Effect.gen(function* () {
			const videosPolicy = yield* VideosPolicy;
			return yield* Effect.promise(() =>
				db()
					.select({
						id: videos.id,
						videoSettings: videos.settings,
						orgSettings: organizations.settings,
						organizationTombstoneAt: organizations.tombstoneAt,
					})
					.from(videos)
					.leftJoin(organizations, eq(videos.orgId, organizations.id))
					.where(eq(videos.id, videoId))
					.limit(1),
			).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
		}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

		if (Exit.isFailure(accessExit)) return failure("Video not found");
		const [video] = accessExit.value;
		if (!video || video.organizationTombstoneAt) {
			return failure("Video not found");
		}

		const { sharedSpaces } = await getSharedSpacesForVideo(videoId);
		const rules = resolveEffectiveVideoRules({
			videoSettings: video.videoSettings,
			organizationSettings: video.orgSettings,
			spaces: ruleSpacesFromSharedSpaces(sharedSpaces),
		});
		if (type === "emoji" && rules.settings.disableReactions) {
			return failure("Reactions are turned off for this video");
		}
		if (type === "text" && rules.settings.disableComments) {
			return failure("Comments are turned off for this video");
		}

		if (parentCommentId) {
			const [parent] = await db()
				.select({ id: comments.id })
				.from(comments)
				.where(
					and(
						eq(comments.id, parentCommentId),
						eq(comments.videoId, videoId),
						eq(comments.type, "text"),
					),
				)
				.limit(1);
			if (!parent) return failure("That comment no longer exists");
		}

		const guestIpHash = hashGuestIp(getClientIp(await headers()) ?? "unknown");
		const now = Date.now();
		const [recentForVideo, recentOverall] = await Promise.all([
			db()
				.select({ id: comments.id })
				.from(comments)
				.where(
					and(
						eq(comments.videoId, videoId),
						eq(comments.guestIpHash, guestIpHash),
						gt(
							comments.createdAt,
							new Date(now - GUEST_COMMENT_LIMITS.perVideo.windowMs),
						),
					),
				)
				.limit(GUEST_COMMENT_LIMITS.perVideo.max),
			db()
				.select({ id: comments.id })
				.from(comments)
				.where(
					and(
						eq(comments.guestIpHash, guestIpHash),
						gt(
							comments.createdAt,
							new Date(now - GUEST_COMMENT_LIMITS.global.windowMs),
						),
					),
				)
				.limit(GUEST_COMMENT_LIMITS.global.max),
		]);
		const throttle = decideGuestCommentThrottle({
			perVideo: recentForVideo.length,
			global: recentOverall.length,
		});
		if (!throttle.allowed) return failure(throttle.error);

		const guestId = User.UserId.make(await ensureGuestId());
		const id = Comment.CommentId.make(nanoId());
		const createdAt = new Date();
		// Web top-level comments persist "" rather than NULL; readers and the
		// comment email throttle accept both.
		const storedParentId = parentCommentId ?? Comment.CommentId.make("");

		await db().insert(comments).values({
			id,
			authorId: guestId,
			type,
			content,
			videoId,
			timestamp,
			parentCommentId: storedParentId,
			guestName,
			guestIpHash,
			createdAt,
			updatedAt: createdAt,
		});

		try {
			await createNotification({
				type: parentCommentId
					? "reply"
					: type === "emoji"
						? "reaction"
						: "comment",
				videoId,
				authorId: guestId,
				comment: { id, content },
				parentCommentId: parentCommentId ?? undefined,
				guestName,
			});
		} catch (error) {
			console.error("Failed to create guest comment notification:", error);
		}

		revalidatePath(`/s/${videoId}`);

		return {
			success: true,
			guestId,
			comment: {
				id,
				authorId: guestId,
				type,
				content,
				videoId,
				timestamp,
				parentCommentId: storedParentId,
				mediaKey: null,
				mediaDuration: null,
				mediaMeta: null,
				guestName,
				createdAt,
				updatedAt: createdAt,
				authorName: guestName,
				authorImage: null,
				sending: false,
			},
		};
	} catch (error) {
		console.error("Failed to post guest comment:", error);
		return failure("Couldn't post your comment. Please try again.");
	}
}
