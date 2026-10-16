import { Database, type DbClient } from "@cap/web-backend/src/Database";
import {
	chunkViewIds,
	sanitizeVideoView,
	toViewCountsByPathname,
	ViewAnalytics,
} from "@cap/web-backend/src/ViewAnalytics";
import { DatabaseError, Organisation, type User, Video } from "@cap/web-domain";
import { drizzle } from "drizzle-orm/mysql-proxy";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {} as { TINYBIRD_TOKEN?: string; TINYBIRD_HOST?: string },
	query: vi.fn(),
}));

vi.mock("@cap/env", () => ({ serverEnv: () => mocks.env }));

import {
	canSeeVideoViewers,
	groupVideoViewers,
	type VideoViewerRow,
} from "@/lib/video-viewers";
import {
	createViewThrottle,
	isViewAnalyticsEnabled,
	readViewerGeo,
	readViewerIp,
} from "@/lib/view-analytics";

const client = drizzle(mocks.query) as unknown as DbClient;
const databaseLayer = Layer.succeed(
	Database,
	Database.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () => callback(client),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	}),
);
const runViewAnalytics = <A, E>(
	effect: Effect.Effect<A, E, ViewAnalytics>,
): Promise<A> =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				ViewAnalytics.DefaultWithoutDependencies.pipe(
					Layer.provide(databaseLayer),
				),
			),
		),
	);

const queries = () =>
	mocks.query.mock.calls.map(([sql, params]) => ({
		sql: String(sql),
		params: params as unknown[],
	}));

const orgId = Organisation.OrganisationId.make("org-1");
const videoA = Video.VideoId.make("video-a");
const videoB = Video.VideoId.make("video-b");

beforeEach(() => {
	mocks.env = {};
	mocks.query.mockResolvedValue({ rows: [] });
});

describe("view analytics helpers", () => {
	it("zero-fills counts keyed by share pathname", () => {
		const counts = toViewCountsByPathname(
			[videoA, videoB],
			[{ videoId: videoB, views: "3" }],
		);
		expect(Object.fromEntries(counts)).toEqual({
			"/s/video-a": 0,
			"/s/video-b": 3,
		});
	});

	it("dedupes ids before chunking", () => {
		expect(chunkViewIds(["a", "b", "a", "c"], 2)).toEqual([["a", "b"], ["c"]]);
	});

	it("clips view fields to their column sizes", () => {
		const view = sanitizeVideoView({
			videoId: videoA,
			orgId,
			sessionId: "s".repeat(200),
			viewerUserId: null,
			viewerName: "  ",
			country: "  CANADA-LONG ",
			region: "r".repeat(100),
			city: "c".repeat(200),
			browser: "b".repeat(100),
			os: "o".repeat(100),
			device: "d".repeat(100),
			createdAt: new Date(),
		});
		expect(view.sessionId).toHaveLength(128);
		expect(view.viewerName).toBeNull();
		expect(view.country).toBe("CANADA-L");
		expect(view.region).toHaveLength(64);
		expect(view.city).toHaveLength(128);
		expect(view.browser).toHaveLength(64);
		expect(view.os).toHaveLength(64);
		expect(view.device).toHaveLength(32);
	});

	it("reads Vercel geo headers before Cloudflare ones", () => {
		expect(
			readViewerGeo(
				new Headers({
					"x-vercel-ip-country": "US",
					"x-vercel-ip-country-region": "CA",
					"x-vercel-ip-city": "San%20Francisco",
					"cf-ipcountry": "CA",
				}),
			),
		).toEqual({ country: "US", region: "CA", city: "San Francisco" });
	});

	it("falls back to Cloudflare geo headers and ignores unknown countries", () => {
		expect(
			readViewerGeo(
				new Headers({ "cf-ipcountry": "CA", "cf-ipcity": "Toronto" }),
			),
		).toEqual({ country: "CA", region: "", city: "Toronto" });
		expect(readViewerGeo(new Headers({ "cf-ipcountry": "XX" }))).toEqual({
			country: "",
			region: "",
			city: "",
		});
	});

	it("reads the first forwarded client ip", () => {
		expect(
			readViewerIp(new Headers({ "x-forwarded-for": "1.1.1.1, 10.0.0.1" })),
		).toBe("1.1.1.1");
		expect(readViewerIp(new Headers())).toBeNull();
	});

	it("throttles per key within a window and evicts expired keys", () => {
		const allow = createViewThrottle({ limit: 2, windowMs: 1000, maxKeys: 2 });
		expect(allow("a", 0)).toBe(true);
		expect(allow("a", 10)).toBe(true);
		expect(allow("a", 20)).toBe(false);
		expect(allow("b", 20)).toBe(true);
		expect(allow("a", 1000)).toBe(true);
		expect(allow("c", 1500)).toBe(true);
		expect(allow("c", 1600)).toBe(true);
		expect(allow("c", 1700)).toBe(false);
	});

	it("keeps view analytics enabled with or without Tinybird", () => {
		expect(isViewAnalyticsEnabled()).toBe(true);
		mocks.env = { TINYBIRD_TOKEN: "token", TINYBIRD_HOST: "https://tb" };
		expect(isViewAnalyticsEnabled()).toBe(true);
	});
});

describe("video viewers", () => {
	const row = (overrides: Partial<VideoViewerRow>): VideoViewerRow => ({
		sessionId: "session",
		viewerUserId: null,
		viewerName: null,
		userName: null,
		userImage: null,
		browser: "Chrome",
		os: "macOS",
		device: "desktop",
		country: "CA",
		city: "Toronto",
		viewedAt: new Date("2026-10-16T10:00:00Z"),
		...overrides,
	});
	const anonymousName = (sessionId: string) => `Anonymous ${sessionId}`;

	it("groups a signed-in user's sessions and names every viewer", () => {
		const viewers = groupVideoViewers(
			[
				row({
					sessionId: "s1",
					viewerUserId: "user-1" as User.UserId,
					userName: "Grace Hopper",
					viewedAt: new Date("2026-10-16T12:00:00Z"),
					browser: "Safari",
					os: "iOS",
				}),
				row({ sessionId: "s2", viewerName: "Ada", city: "", country: "GB" }),
				row({
					sessionId: "s3",
					viewerUserId: "user-1" as User.UserId,
					userName: "Grace Hopper",
					viewedAt: new Date("2026-10-15T12:00:00Z"),
				}),
				row({
					sessionId: "anon",
					browser: "unknown",
					viewedAt: new Date("2026-10-14T12:00:00Z"),
				}),
			],
			anonymousName,
		);

		expect(
			viewers.map(({ name, kind, sessions, browser, os, location }) => ({
				name,
				kind,
				sessions,
				browser,
				os,
				location,
			})),
		).toEqual([
			{
				name: "Grace Hopper",
				kind: "user",
				sessions: 2,
				browser: "Safari",
				os: "iOS",
				location: "Toronto, CA",
			},
			{
				name: "Ada",
				kind: "guest",
				sessions: 1,
				browser: "Chrome",
				os: "macOS",
				location: "GB",
			},
			{
				name: "Anonymous anon",
				kind: "anonymous",
				sessions: 1,
				browser: null,
				os: "macOS",
				location: "Toronto, CA",
			},
		]);
	});

	it("allows only the owner and organization admins", () => {
		expect(
			canSeeVideoViewers({
				viewerId: "u",
				ownerId: "u",
				organizationRole: null,
			}),
		).toBe(true);
		expect(
			canSeeVideoViewers({
				viewerId: "a",
				ownerId: "u",
				organizationRole: "admin",
			}),
		).toBe(true);
		expect(
			canSeeVideoViewers({
				viewerId: "m",
				ownerId: "u",
				organizationRole: "member",
			}),
		).toBe(false);
		expect(
			canSeeVideoViewers({
				viewerId: "x",
				ownerId: "u",
				organizationRole: null,
			}),
		).toBe(false);
	});
});

describe("ViewAnalytics MySQL queries", () => {
	const range = {
		from: new Date("2026-10-15T12:00:00Z"),
		to: new Date("2026-10-16T12:00:00Z"),
	};

	it("counts distinct sessions per video with bound ids", async () => {
		mocks.query.mockResolvedValueOnce({ rows: [[videoA, 4]] });
		const counts = await runViewAnalytics(
			Effect.flatMap(ViewAnalytics, (service) =>
				service.countsByPathname([videoA, videoB], range),
			),
		);

		expect(Object.fromEntries(counts)).toEqual({
			"/s/video-a": 4,
			"/s/video-b": 0,
		});
		const [query] = queries();
		expect(query?.sql).toContain("COUNT(DISTINCT `sessionId`)");
		expect(query?.sql).not.toContain("video-a");
		expect(query?.params).toEqual(
			expect.arrayContaining([videoA, videoB, "2026-10-15 12:00:00.000"]),
		);
	});

	it("returns dashboard series and breakdowns in the Tinybird shapes", async () => {
		mocks.query.mockImplementation(async (sql: string) => {
			if (sql.includes("DATE_FORMAT")) {
				return { rows: [["2026-10-16T11:00:00Z", 2]] };
			}
			if (sql.includes("inner join `videos`")) {
				return { rows: [[videoA, 2]] };
			}
			if (sql.includes("`video_views`.`city`")) {
				return { rows: [["CA", "Toronto", 2]] };
			}
			if (sql.includes("`video_views`.`browser`")) {
				return { rows: [["Chrome", "2"]] };
			}
			if (sql.includes("`video_views`.`device`")) {
				return { rows: [["desktop", 2]] };
			}
			if (sql.includes("`video_views`.`os`")) {
				return { rows: [["macOS", 2]] };
			}
			if (sql.includes("`video_views`.`country`")) {
				return { rows: [["CA", 2]] };
			}
			return { rows: [] };
		});

		const data = await runViewAnalytics(
			Effect.flatMap(ViewAnalytics, (service) =>
				service.orgAnalytics({
					orgId,
					...range,
					bucket: "hour",
					videoIds: [videoA],
					includeTopCaps: true,
				}),
			),
		);

		expect(data).toEqual({
			viewSeries: [{ bucket: "2026-10-16T11:00:00Z", views: 2 }],
			countries: [{ name: "CA", views: 2 }],
			cities: [{ name: "Toronto", subtitle: "CA", views: 2 }],
			browsers: [{ name: "Chrome", views: 2 }],
			devices: [{ name: "desktop", views: 2 }],
			operatingSystems: [{ name: "macOS", views: 2 }],
			topCapsRaw: [{ videoId: videoA, views: 2 }],
		});

		const sqls = queries().map((query) => query.sql);
		expect(sqls).toHaveLength(7);
		expect(sqls.some((sql) => sql.includes("'%Y-%m-%dT%H:00:00Z'"))).toBe(true);
		expect(
			sqls.some((sql) =>
				sql.includes("COALESCE(NULLIF(`video_views`.`device`, ''), 'desktop')"),
			),
		).toBe(true);
		expect(sqls.filter((sql) => sql.includes(" limit ")).length).toBe(6);
		for (const query of queries()) {
			expect(query.sql).not.toContain("org-1");
			expect(query.sql).not.toContain("video-a");
			expect(query.params).toEqual(expect.arrayContaining([orgId, videoA]));
		}
	});

	it("buckets by day and skips top caps when a cap is selected", async () => {
		await runViewAnalytics(
			Effect.flatMap(ViewAnalytics, (service) =>
				service.orgAnalytics({
					orgId,
					...range,
					bucket: "day",
					includeTopCaps: false,
				}),
			),
		);

		const sqls = queries().map((query) => query.sql);
		expect(sqls).toHaveLength(6);
		expect(sqls.some((sql) => sql.includes("'%Y-%m-%dT00:00:00Z'"))).toBe(true);
		expect(sqls.some((sql) => sql.includes("inner join `videos`"))).toBe(false);
		expect(sqls.some((sql) => sql.includes("`video_views`.`videoId` in"))).toBe(
			false,
		);
	});
});
