"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { ImageUploads, Tinybird, ViewAnalytics } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { getOrganizationAccess } from "@/actions/organization/authorization";
import { getAnonymousName } from "@/lib/anonymous-names";
import { runPromise } from "@/lib/server";
import {
	canSeeVideoViewers,
	groupVideoViewers,
	VIDEO_VIEWERS_LIMIT,
	type VideoViewersResult,
} from "@/lib/video-viewers";

export async function getVideoViewers(
	videoId: string,
): Promise<VideoViewersResult | null> {
	if (typeof videoId !== "string" || !videoId) return null;

	const user = await getCurrentUser();
	if (!user) return null;

	const id = Video.VideoId.make(videoId);
	const [video] = await db()
		.select({ ownerId: videos.ownerId, orgId: videos.orgId })
		.from(videos)
		.where(eq(videos.id, id))
		.limit(1);
	if (!video) return null;

	const organizationRole =
		video.ownerId === user.id
			? null
			: ((await getOrganizationAccess(user.id, video.orgId))?.role ?? null);

	if (
		!canSeeVideoViewers({
			viewerId: user.id,
			ownerId: video.ownerId,
			organizationRole,
		})
	) {
		return null;
	}

	return runPromise(
		Effect.gen(function* () {
			const tinybird = yield* Tinybird;
			if (tinybird.enabled) return null;

			const viewAnalytics = yield* ViewAnalytics;
			const imageUploads = yield* ImageUploads;

			const { rows, total } = yield* viewAnalytics.listViewers(
				id,
				VIDEO_VIEWERS_LIMIT,
			);
			const grouped = groupVideoViewers(rows, getAnonymousName);

			const viewers = yield* Effect.forEach(
				grouped,
				({ imageKey, key: _key, ...viewer }, index) =>
					Option.fromNullable(imageKey).pipe(
						Option.map(imageUploads.resolveImageUrl),
						Effect.transposeOption,
						Effect.map(Option.getOrNull),
						Effect.catchAll(() => Effect.succeed(null)),
						Effect.map((image) => ({
							...viewer,
							id: `${viewer.kind}-${index}`,
							image,
						})),
					),
				{ concurrency: 5 },
			);

			return { total: Math.max(total, viewers.length), viewers };
		}),
	);
}
