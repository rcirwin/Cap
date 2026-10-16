import { nanoId } from "@cap/database/helpers";
import * as Db from "@cap/database/schema";
import type { Organisation, User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect } from "effect";

import { Database } from "../Database.ts";

export type ViewBucket = "hour" | "day";

export interface ViewRange {
	from: Date;
	to: Date;
}

export interface VideoViewInput {
	videoId: Video.VideoId;
	orgId: Organisation.OrganisationId;
	sessionId: string;
	viewerUserId: User.UserId | null;
	viewerName: string | null;
	country: string;
	region: string;
	city: string;
	browser: string;
	os: string;
	device: string;
	createdAt: Date;
}

export interface OrgViewAnalyticsInput extends ViewRange {
	orgId: Organisation.OrganisationId;
	bucket: ViewBucket;
	videoIds?: ReadonlyArray<Video.VideoId>;
	includeTopCaps: boolean;
}

export interface ViewBreakdownRow {
	name: string;
	views: number;
	subtitle?: string;
}

export interface OrgViewAnalytics {
	viewSeries: Array<{ bucket: string; views: number }>;
	countries: ViewBreakdownRow[];
	cities: ViewBreakdownRow[];
	browsers: ViewBreakdownRow[];
	devices: ViewBreakdownRow[];
	operatingSystems: ViewBreakdownRow[];
	topCapsRaw: Array<{ videoId: string; views: number }>;
}

const VIEW_BREAKDOWN_LIMIT = 10;
const VIEW_COUNT_CHUNK_SIZE = 500;

const VIDEO_VIEW_COLUMN_LIMITS = {
	sessionId: 128,
	viewerName: 64,
	country: 8,
	region: 64,
	city: 128,
	browser: 64,
	os: 64,
	device: 32,
} as const;

export const emptyOrgViewAnalytics = (): OrgViewAnalytics => ({
	viewSeries: [],
	countries: [],
	cities: [],
	browsers: [],
	devices: [],
	operatingSystems: [],
	topCapsRaw: [],
});

const buildViewPathname = (videoId: string) => `/s/${videoId}`;

const toViewCount = (value: unknown) => {
	const count = Number(value);
	return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
};

const clipViewField = (value: string | null | undefined, max: number) =>
	(value ?? "").trim().slice(0, max);

export const toViewCountsByPathname = (
	videoIds: ReadonlyArray<string>,
	rows: ReadonlyArray<{ videoId: string; views: unknown }>,
) => {
	const counts = new Map<string, number>();
	for (const videoId of videoIds) counts.set(buildViewPathname(videoId), 0);
	for (const row of rows) {
		counts.set(buildViewPathname(row.videoId), toViewCount(row.views));
	}
	return counts;
};

export const chunkViewIds = <T>(ids: ReadonlyArray<T>, size: number) => {
	const unique = Array.from(new Set(ids));
	const chunks: T[][] = [];
	for (let index = 0; index < unique.length; index += size) {
		chunks.push(unique.slice(index, index + size));
	}
	return chunks;
};

export const sanitizeVideoView = (view: VideoViewInput): VideoViewInput => {
	const limits = VIDEO_VIEW_COLUMN_LIMITS;
	const viewerName = view.viewerName
		? clipViewField(view.viewerName, limits.viewerName)
		: "";
	return {
		...view,
		sessionId: clipViewField(view.sessionId, limits.sessionId) || "anon",
		viewerName: viewerName || null,
		country: clipViewField(view.country, limits.country),
		region: clipViewField(view.region, limits.region),
		city: clipViewField(view.city, limits.city),
		browser: clipViewField(view.browser, limits.browser),
		os: clipViewField(view.os, limits.os),
		device: clipViewField(view.device, limits.device),
	};
};

const viewCountExpr = Dz.sql<number>`COUNT(*)`.mapWith(Number);

const viewBucketExpr = (bucket: ViewBucket) =>
	bucket === "hour"
		? Dz.sql<string>`DATE_FORMAT(${Db.videoViews.createdAt}, '%Y-%m-%dT%H:00:00Z')`
		: Dz.sql<string>`DATE_FORMAT(${Db.videoViews.createdAt}, '%Y-%m-%dT00:00:00Z')`;

const breakdownNameExpr = (
	column: Dz.AnyColumn,
	fallback: "unknown" | "desktop",
) =>
	fallback === "desktop"
		? Dz.sql<string>`COALESCE(NULLIF(${column}, ''), 'desktop')`
		: Dz.sql<string>`COALESCE(NULLIF(${column}, ''), 'unknown')`;

export class ViewAnalytics extends Effect.Service<ViewAnalytics>()(
	"ViewAnalytics",
	{
		effect: Effect.gen(function* () {
			const db = yield* Database;

			const record = Effect.fn("ViewAnalytics.record")(function* (
				input: VideoViewInput,
			) {
				const view = sanitizeVideoView(input);
				yield* db.use((database) =>
					database
						.insert(Db.videoViews)
						.values({ id: nanoId(), ...view })
						.onDuplicateKeyUpdate({
							set: {
								viewerUserId: Dz.sql`COALESCE(${Db.videoViews.viewerUserId}, ${view.viewerUserId})`,
								viewerName: Dz.sql`COALESCE(${view.viewerName}, ${Db.videoViews.viewerName})`,
							},
						}),
				);
			});

			const countForVideo = Effect.fn("ViewAnalytics.countForVideo")(function* (
				videoId: Video.VideoId,
				range: ViewRange,
			) {
				const [row] = yield* db.use((database) =>
					database
						.select({
							views: Dz.sql<number>`COUNT(DISTINCT ${Db.videoViews.sessionId})`,
						})
						.from(Db.videoViews)
						.where(
							Dz.and(
								Dz.eq(Db.videoViews.videoId, videoId),
								Dz.between(Db.videoViews.createdAt, range.from, range.to),
							),
						),
				);
				return toViewCount(row?.views);
			});

			const countsByPathname = Effect.fn("ViewAnalytics.countsByPathname")(
				function* (videoIds: ReadonlyArray<Video.VideoId>, range: ViewRange) {
					const rows = yield* Effect.forEach(
						chunkViewIds(videoIds, VIEW_COUNT_CHUNK_SIZE),
						(chunk) =>
							db.use((database) =>
								database
									.select({
										videoId: Db.videoViews.videoId,
										views: Dz.sql<number>`COUNT(DISTINCT ${Db.videoViews.sessionId})`,
									})
									.from(Db.videoViews)
									.where(
										Dz.and(
											Dz.inArray(Db.videoViews.videoId, chunk),
											Dz.between(Db.videoViews.createdAt, range.from, range.to),
										),
									)
									.groupBy(Db.videoViews.videoId),
							),
						{ concurrency: 2 },
					);
					return toViewCountsByPathname(videoIds, rows.flat());
				},
			);

			const orgAnalytics = Effect.fn("ViewAnalytics.orgAnalytics")(function* (
				input: OrgViewAnalyticsInput,
			) {
				const where = Dz.and(
					Dz.eq(Db.videoViews.orgId, input.orgId),
					Dz.between(Db.videoViews.createdAt, input.from, input.to),
					input.videoIds && input.videoIds.length > 0
						? Dz.inArray(Db.videoViews.videoId, [...input.videoIds])
						: undefined,
				);

				const bucketExpr = viewBucketExpr(input.bucket);
				const viewSeries = db.use((database) =>
					database
						.select({ bucket: bucketExpr, views: viewCountExpr })
						.from(Db.videoViews)
						.where(where)
						.groupBy(bucketExpr)
						.orderBy(bucketExpr),
				);

				const countries = db.use((database) =>
					database
						.select({ name: Db.videoViews.country, views: viewCountExpr })
						.from(Db.videoViews)
						.where(Dz.and(where, Dz.ne(Db.videoViews.country, "")))
						.groupBy(Db.videoViews.country)
						.orderBy(Dz.desc(viewCountExpr))
						.limit(VIEW_BREAKDOWN_LIMIT),
				);

				const cities = db.use((database) =>
					database
						.select({
							country: Db.videoViews.country,
							city: Db.videoViews.city,
							views: viewCountExpr,
						})
						.from(Db.videoViews)
						.where(Dz.and(where, Dz.ne(Db.videoViews.city, "")))
						.groupBy(Db.videoViews.country, Db.videoViews.city)
						.orderBy(Dz.desc(viewCountExpr))
						.limit(VIEW_BREAKDOWN_LIMIT),
				);

				const breakdown = (nameExpr: Dz.SQL<string>) =>
					db.use((database) =>
						database
							.select({ name: nameExpr, views: viewCountExpr })
							.from(Db.videoViews)
							.where(where)
							.groupBy(nameExpr)
							.orderBy(Dz.desc(viewCountExpr))
							.limit(VIEW_BREAKDOWN_LIMIT),
					);

				const topCaps = input.includeTopCaps
					? db.use((database) =>
							database
								.select({
									videoId: Db.videoViews.videoId,
									views: viewCountExpr,
								})
								.from(Db.videoViews)
								.innerJoin(
									Db.videos,
									Dz.eq(Db.videos.id, Db.videoViews.videoId),
								)
								.where(where)
								.groupBy(Db.videoViews.videoId)
								.orderBy(Dz.desc(viewCountExpr))
								.limit(VIEW_BREAKDOWN_LIMIT),
						)
					: Effect.succeed<Array<{ videoId: Video.VideoId; views: number }>>(
							[],
						);

				const rows = yield* Effect.all(
					{
						viewSeries,
						countries,
						cities,
						browsers: breakdown(
							breakdownNameExpr(Db.videoViews.browser, "unknown"),
						),
						devices: breakdown(
							breakdownNameExpr(Db.videoViews.device, "desktop"),
						),
						operatingSystems: breakdown(
							breakdownNameExpr(Db.videoViews.os, "unknown"),
						),
						topCaps,
					},
					{ concurrency: 4 },
				);

				const toBreakdown = (
					list: ReadonlyArray<{ name: string | null; views: unknown }>,
				): ViewBreakdownRow[] =>
					list.map((row) => ({
						name: row.name ?? "",
						views: toViewCount(row.views),
					}));

				return {
					viewSeries: rows.viewSeries.flatMap((row) =>
						row.bucket
							? [{ bucket: row.bucket, views: toViewCount(row.views) }]
							: [],
					),
					countries: toBreakdown(rows.countries),
					cities: rows.cities.map((row) => ({
						name: row.city,
						subtitle: row.country,
						views: toViewCount(row.views),
					})),
					browsers: toBreakdown(rows.browsers),
					devices: toBreakdown(rows.devices),
					operatingSystems: toBreakdown(rows.operatingSystems),
					topCapsRaw: rows.topCaps.map((row) => ({
						videoId: row.videoId,
						views: toViewCount(row.views),
					})),
				} satisfies OrgViewAnalytics;
			});

			const listViewers = Effect.fn("ViewAnalytics.listViewers")(function* (
				videoId: Video.VideoId,
				limit: number,
			) {
				const [rows, [summary]] = yield* Effect.all(
					[
						db.use((database) =>
							database
								.select({
									sessionId: Db.videoViews.sessionId,
									viewerUserId: Db.videoViews.viewerUserId,
									viewerName: Db.videoViews.viewerName,
									userName: Db.users.name,
									userImage: Db.users.image,
									browser: Db.videoViews.browser,
									os: Db.videoViews.os,
									device: Db.videoViews.device,
									country: Db.videoViews.country,
									city: Db.videoViews.city,
									viewedAt: Db.videoViews.createdAt,
								})
								.from(Db.videoViews)
								.leftJoin(
									Db.users,
									Dz.eq(Db.users.id, Db.videoViews.viewerUserId),
								)
								.where(Dz.eq(Db.videoViews.videoId, videoId))
								.orderBy(Dz.desc(Db.videoViews.createdAt))
								.limit(limit),
						),
						db.use((database) =>
							database
								.select({
									people: Dz.sql<number>`COUNT(DISTINCT COALESCE(CONCAT('u:', ${Db.videoViews.viewerUserId}), CONCAT('s:', ${Db.videoViews.sessionId})))`,
								})
								.from(Db.videoViews)
								.where(Dz.eq(Db.videoViews.videoId, videoId)),
						),
					],
					{ concurrency: 2 },
				);
				return { rows, total: toViewCount(summary?.people) };
			});

			return {
				record,
				countForVideo,
				countsByPathname,
				orgAnalytics,
				listViewers,
			} as const;
		}),
		dependencies: [Database.Default],
	},
) {}
