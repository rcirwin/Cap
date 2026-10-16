"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { comments, notifications, videos } from "@cap/database/schema";
import { Storage, VideosRepo } from "@cap/web-backend";
import type { Comment, Video } from "@cap/web-domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { type CommentActor, canDeleteComment } from "@/lib/guest-comments";
import { readGuestId } from "@/lib/guest-identity";
import * as EffectRuntime from "@/lib/server";

async function getCommentActor(): Promise<CommentActor | null> {
	const user = await getCurrentUser();
	if (user) return { kind: "user", id: user.id };
	const guestId = await readGuestId();
	return guestId ? { kind: "guest", id: guestId } : null;
}

export async function deleteComment({
	commentId,
	videoId,
}: {
	commentId: Comment.CommentId;
	parentId: Comment.CommentId | null;
	videoId: Video.VideoId;
}) {
	const actor = await getCommentActor();

	if (!actor) {
		throw new Error("User not authenticated");
	}

	if (!commentId || !videoId) {
		throw new Error("Comment ID and video ID are required");
	}

	try {
		let deletedMedia: {
			videoId: Video.VideoId;
			mediaKey: string;
			thumbnailKey: string | null;
		} | null = null;
		let commentVideoId = videoId;

		await db().transaction(async (tx) => {
			const [existingComment] = await tx
				.select({
					id: comments.id,
					authorId: comments.authorId,
					videoId: comments.videoId,
					parentCommentId: comments.parentCommentId,
					mediaKey: comments.mediaKey,
					mediaMeta: comments.mediaMeta,
					videoOwnerId: videos.ownerId,
				})
				.from(comments)
				.leftJoin(videos, eq(videos.id, comments.videoId))
				.where(eq(comments.id, commentId))
				.limit(1);

			if (
				!existingComment ||
				!canDeleteComment({
					actor,
					authorId: existingComment.authorId,
					videoOwnerId: existingComment.videoOwnerId,
				})
			) {
				throw new Error(
					"Comment not found or you don't have permission to delete it",
				);
			}

			commentVideoId = existingComment.videoId;

			if (existingComment.mediaKey) {
				deletedMedia = {
					// The comment's own videoId, not the client-supplied one, decides
					// which bucket the objects are deleted from.
					videoId: existingComment.videoId,
					mediaKey: existingComment.mediaKey,
					thumbnailKey: existingComment.mediaMeta?.thumbnailKey ?? null,
				};
			}

			await tx.delete(comments).where(eq(comments.id, commentId));

			if (existingComment.parentCommentId) {
				await tx
					.delete(notifications)
					.where(
						and(
							eq(notifications.type, "reply"),
							sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`,
						),
					);
			} else {
				await tx
					.delete(notifications)
					.where(
						and(
							inArray(notifications.type, ["comment", "reaction"]),
							sql`JSON_EXTRACT(${notifications.data}, '$.comment.id') = ${commentId}`,
						),
					);

				// createNotification stores parentCommentId at the top level of
				// data, not under comment.
				await tx
					.delete(notifications)
					.where(
						and(
							eq(notifications.type, "reply"),
							sql`JSON_EXTRACT(${notifications.data}, '$.parentCommentId') = ${commentId}`,
						),
					);
			}
		});

		// After the row is gone, best-effort delete of the media objects; a
		// storage failure must not fail the action (the video-delete prefix sweep
		// reclaims any stragglers).
		if (deletedMedia) {
			const { videoId: mediaVideoId, mediaKey, thumbnailKey } = deletedMedia;
			await Effect.gen(function* () {
				const repo = yield* VideosRepo;
				const maybeVideo = yield* repo.getById(mediaVideoId);
				if (Option.isNone(maybeVideo)) return;
				const [bucket] = yield* Storage.getAccessForVideo(maybeVideo.value[0]);
				yield* bucket.deleteObjects([
					{ Key: mediaKey },
					...(thumbnailKey ? [{ Key: thumbnailKey }] : []),
				]);
			}).pipe(
				// catchAllCause, not catchAll: a defect (missing credential, storage
				// layer panic) must not fail the action either — the row is gone.
				Effect.catchAllCause((cause) =>
					Effect.logError("Failed to delete comment media objects", cause),
				),
				EffectRuntime.runPromise,
			);
		}

		revalidatePath(`/s/${commentVideoId}`);
		return { success: true };
	} catch (error) {
		console.error("Error deleting comment:", error);
		throw error;
	}
}
