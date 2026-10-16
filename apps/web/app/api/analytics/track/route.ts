import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { provideOptionalAuth, Tinybird, ViewAnalytics } from "@cap/web-backend";
import { CurrentUser, type Organisation, User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import type { NextRequest } from "next/server";
import UAParser from "ua-parser-js";

import { getAnonymousName } from "@/lib/anonymous-names";
import { normalizeGuestName } from "@/lib/guest-name";
import {
	createAnonymousViewNotification,
	sendFirstViewEmail,
} from "@/lib/Notification";
import { runPromise } from "@/lib/server";
import {
	createViewThrottle,
	MAX_TRACK_PAYLOAD_LENGTH,
	readViewerGeo,
	readViewerIp,
	sanitizeTrackValue,
} from "@/lib/view-analytics";

interface TrackPayload {
	videoId: string;
	orgId?: string | null;
	ownerId?: string | null;
	sessionId?: string;
	pathname?: string;
	hostname?: string | null;
	userAgent?: string;
	occurredAt?: string;
	guestName?: string | null;
}

const VIEW_TRACKING_DELAY_MS = 2 * 60 * 1000;

const allowViewWrite = createViewThrottle({
	limit: 60,
	windowMs: 60 * 1000,
	maxKeys: 10_000,
});

const payloadTooLarge = () =>
	Response.json({ error: "Payload too large" }, { status: 413 });

export async function POST(request: NextRequest) {
	if (
		Number(request.headers.get("content-length") ?? 0) >
		MAX_TRACK_PAYLOAD_LENGTH
	) {
		return payloadTooLarge();
	}

	let body: TrackPayload;
	try {
		const rawBody = await request.text();
		if (rawBody.length > MAX_TRACK_PAYLOAD_LENGTH) return payloadTooLarge();
		body = JSON.parse(rawBody) as TrackPayload;
	} catch (_error) {
		return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
	}

	if (!body?.videoId || typeof body.videoId !== "string") {
		return Response.json({ error: "videoId is required" }, { status: 400 });
	}

	const parsedSessionId =
		typeof body.sessionId === "string"
			? body.sessionId.trim().slice(0, 128) || null
			: null;
	const sessionId =
		parsedSessionId && parsedSessionId !== "anonymous" ? parsedSessionId : null;
	const userAgent =
		sanitizeTrackValue(request.headers.get("user-agent")) ||
		sanitizeTrackValue(body.userAgent) ||
		"unknown";
	const parser = new UAParser(userAgent);
	const browserName = parser.getBrowser().name ?? "unknown";
	const osName = parser.getOS().name ?? "unknown";
	const deviceType = parser.getDevice().type ?? "desktop";

	const timestamp = body.occurredAt ? new Date(body.occurredAt) : new Date();

	const { country, region, city } = readViewerGeo(request.headers);
	const viewerIp = readViewerIp(request.headers);
	const guestName = normalizeGuestName(body.guestName);

	const hostname =
		sanitizeTrackValue(body.hostname) ||
		sanitizeTrackValue(request.nextUrl.hostname) ||
		"";

	const pathname = body.pathname ?? `/s/${body.videoId}`;

	await runPromise(
		Effect.gen(function* () {
			const maybeUser = yield* Effect.serviceOption(CurrentUser);
			const userId = Option.match(maybeUser, {
				onNone: () => null as string | null,
				onSome: (user) => {
					const currentUser = user as {
						id: string;
						email: string;
						activeOrganizationId: string;
						iconUrlOrKey: Option.Option<unknown>;
					};
					return currentUser.id;
				},
			});

			const ANON_NOTIF_CUTOFF = new Date("2026-03-04T00:00:00Z");

			const [videoRecord] = yield* Effect.tryPromise(() =>
				db()
					.select({
						ownerId: videos.ownerId,
						orgId: videos.orgId,
						firstViewEmailSentAt: videos.firstViewEmailSentAt,
						videoName: videos.name,
						createdAt: videos.createdAt,
						updatedAt: videos.updatedAt,
						activeUploadVideoId: videoUploads.videoId,
					})
					.from(videos)
					.leftJoin(videoUploads, eq(videoUploads.videoId, videos.id))
					.where(eq(videos.id, Video.VideoId.make(body.videoId)))
					.limit(1),
			).pipe(
				Effect.orElseSucceed(
					() =>
						[] as {
							ownerId: string;
							orgId: Organisation.OrganisationId;
							firstViewEmailSentAt: Date | null;
							videoName: string;
							createdAt: Date;
							updatedAt: Date;
							activeUploadVideoId: string | null;
						}[],
				),
			);

			if (videoRecord && userId === videoRecord.ownerId) {
				return;
			}

			if (
				videoRecord &&
				(videoRecord.activeUploadVideoId ||
					Date.now() - videoRecord.updatedAt.getTime() < VIEW_TRACKING_DELAY_MS)
			) {
				return;
			}

			const tenantId =
				body.orgId ||
				videoRecord?.ownerId ||
				body.ownerId ||
				(hostname ? `domain:${hostname}` : "public");

			const tinybird = yield* Tinybird;
			if (tinybird.enabled) {
				yield* tinybird.appendEvents([
					{
						timestamp: timestamp.toISOString(),
						session_id: sessionId ?? "anon",
						action: "page_hit",
						version: "1.0",
						tenant_id: tenantId,
						video_id: body.videoId,
						pathname,
						country,
						region,
						city,
						browser: browserName,
						device: deviceType,
						os: osName,
						user_id: userId,
					},
				]);
			} else if (videoRecord && (!viewerIp || allowViewWrite(viewerIp))) {
				const viewAnalytics = yield* ViewAnalytics;
				yield* viewAnalytics
					.record({
						videoId: Video.VideoId.make(body.videoId),
						orgId: videoRecord.orgId,
						sessionId: sessionId ?? (userId ? `user:${userId}` : "anon"),
						viewerUserId: userId ? User.UserId.make(userId) : null,
						viewerName: sessionId ? guestName : null,
						country,
						region,
						city,
						browser: browserName,
						os: osName,
						device: deviceType,
						createdAt: new Date(),
					})
					.pipe(
						Effect.catchAll((error) =>
							Effect.sync(() =>
								console.error("Failed to record video view:", error),
							),
						),
					);
			}

			const isNewVideo =
				videoRecord && videoRecord.createdAt >= ANON_NOTIF_CUTOFF;
			const shouldSendFirstViewEmail =
				isNewVideo && !videoRecord.firstViewEmailSentAt;

			if (userId) {
				if (shouldSendFirstViewEmail) {
					yield* Effect.forkDaemon(
						Effect.tryPromise(() =>
							sendFirstViewEmail({
								videoId: body.videoId,
								viewerUserId: userId,
								isAnonymous: false,
							}),
						).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to send first view email:", error);
								return Effect.void;
							}),
						),
					);
				}
			}

			if (!userId && sessionId && isNewVideo) {
				const anonName = guestName ?? getAnonymousName(sessionId);
				const location =
					city && country ? `${city}, ${country}` : city || country || null;

				const effects: Effect.Effect<void, never, never>[] = [
					Effect.tryPromise(() =>
						createAnonymousViewNotification({
							videoId: body.videoId,
							sessionId,
							anonName,
							location,
						}),
					).pipe(
						Effect.catchAll((error) => {
							console.error(
								"Failed to create anonymous view notification:",
								error,
							);
							return Effect.void;
						}),
					),
				];

				if (shouldSendFirstViewEmail) {
					effects.push(
						Effect.tryPromise(() =>
							sendFirstViewEmail({
								videoId: body.videoId,
								viewerName: anonName,
								isAnonymous: true,
							}),
						).pipe(
							Effect.catchAll((error) => {
								console.error("Failed to send first view email:", error);
								return Effect.void;
							}),
						),
					);
				}

				yield* Effect.forkDaemon(Effect.all(effects));
			}

			if (!userId && !sessionId && isNewVideo && shouldSendFirstViewEmail) {
				yield* Effect.forkDaemon(
					Effect.tryPromise(() =>
						sendFirstViewEmail({
							videoId: body.videoId,
							viewerName: "Anonymous Viewer",
							isAnonymous: true,
						}),
					).pipe(
						Effect.catchAll((error) => {
							console.error("Failed to send first view email:", error);
							return Effect.void;
						}),
					),
				);
			}
		}).pipe(provideOptionalAuth),
	);

	return Response.json({ success: true });
}
