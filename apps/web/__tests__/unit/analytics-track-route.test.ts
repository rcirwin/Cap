import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAnonymousViewNotification } from "@/lib/Notification";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	appendEvents: vi.fn(),
	tinybirdEnabled: false,
	userId: null as string | null,
	video: {
		ownerId: "owner-1",
		orgId: "org-1",
		createdAt: "2025-01-01 00:00:00",
		activeUploadVideoId: null as string | null,
	},
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});

vi.mock("@/lib/Notification", () => ({
	createAnonymousViewNotification: vi.fn(async () => undefined),
	sendFirstViewEmail: vi.fn(async () => undefined),
}));

vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	const { CurrentUser, Organisation, User } = await import("@cap/web-domain");
	const { Effect, Option } = await import("effect");
	return {
		...actual,
		provideOptionalAuth: <A, E, R>(
			effect: import("effect").Effect.Effect<A, E, R>,
		) =>
			mocks.userId
				? Effect.provideService(effect, CurrentUser, {
						id: User.UserId.make(mocks.userId),
						email: "viewer@example.com",
						activeOrganizationId: Organisation.OrganisationId.make("org-1"),
						iconUrlOrKey: Option.none(),
					})
				: effect,
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect, Layer } = await import("effect");
	const { Tinybird, ViewAnalytics } = await import("@cap/web-backend");
	return {
		runPromise: <A, E>(
			effect: import("effect").Effect.Effect<
				A,
				E,
				| import("@cap/web-backend").Tinybird
				| import("@cap/web-backend").ViewAnalytics
			>,
		): Promise<A> =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(
						Layer.mergeAll(
							Layer.succeed(
								Tinybird,
								Tinybird.make({
									enabled: mocks.tinybirdEnabled,
									appendEvents: (rows) => {
										mocks.appendEvents(rows);
										return Effect.void;
									},
									queryPipe: () => Effect.succeed({ data: [] }),
									querySql: () => Effect.succeed({ data: [] }),
									deleteData: () => Effect.void,
								}),
							),
							ViewAnalytics.Default,
						),
					),
				),
			),
	};
});

import { POST } from "@/app/api/analytics/track/route";

const CHROME_MAC_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const track = (body: unknown, headers: Record<string, string> = {}) =>
	POST(
		new NextRequest("http://localhost/api/analytics/track", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
			headers: {
				"content-type": "application/json",
				"user-agent": CHROME_MAC_UA,
				...headers,
			},
		}),
	);

const inserts = () =>
	mocks.query.mock.calls
		.map(([sql, params]) => ({ sql: String(sql), params: params as unknown[] }))
		.filter((query) => query.sql.startsWith("insert into `video_views`"));

beforeEach(() => {
	mocks.tinybirdEnabled = false;
	mocks.userId = null;
	mocks.video = {
		ownerId: "owner-1",
		orgId: "org-1",
		createdAt: "2025-01-01 00:00:00",
		activeUploadVideoId: null,
	};
	vi.mocked(createAnonymousViewNotification).mockClear();
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql.startsWith("select") && sql.includes("from `videos`")) {
			return {
				rows: [
					[
						mocks.video.ownerId,
						mocks.video.orgId,
						null,
						"Demo",
						mocks.video.createdAt,
						mocks.video.createdAt,
						mocks.video.activeUploadVideoId,
					],
				],
			};
		}
		if (sql.startsWith("insert")) {
			return { rows: [{ affectedRows: 1, insertId: 0 }] };
		}
		return { rows: [] };
	});
});

describe("POST /api/analytics/track without Tinybird", () => {
	it("records an anonymous view with the guest name, device and geo", async () => {
		const consoleError = vi.spyOn(console, "error");
		const response = await track(
			{
				videoId: "video-1",
				orgId: "spoofed-org",
				sessionId: "session-1",
				guestName: "  Ada   Lovelace ",
			},
			{ "cf-ipcountry": "CA", "x-forwarded-for": "203.0.113.1" },
		);

		expect(response.status).toBe(200);
		const [insert] = inserts();
		expect(insert?.sql).toContain("on duplicate key update");
		expect(insert?.sql).toContain("COALESCE(`video_views`.`viewerName`, ?)");
		expect(insert?.sql).toContain("COALESCE(`video_views`.`viewerUserId`, ?)");
		expect(insert?.params.slice(1, 12)).toEqual([
			"video-1",
			"org-1",
			"session-1",
			null,
			"Ada Lovelace",
			"CA",
			"",
			"",
			"Chrome",
			"Mac OS",
			"desktop",
		]);
		expect(insert?.params).not.toContain("spoofed-org");
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("names anonymous view notifications after the guest when known", async () => {
		mocks.video.createdAt = "2026-10-01 00:00:00";
		await track({
			videoId: "video-1",
			sessionId: "session-guest",
			guestName: " Ada ",
		});
		await vi.waitFor(() =>
			expect(createAnonymousViewNotification).toHaveBeenCalledWith(
				expect.objectContaining({ anonName: "Ada" }),
			),
		);
	});

	it("falls back to a generated animal name without a guest name", async () => {
		mocks.video.createdAt = "2026-10-01 00:00:00";
		await track({ videoId: "video-1", sessionId: "session-anon" });
		await vi.waitFor(() =>
			expect(createAnonymousViewNotification).toHaveBeenCalledWith(
				expect.objectContaining({
					anonName: expect.stringMatching(/^Anonymous /),
				}),
			),
		);
	});

	it("attributes signed-in viewers without a session to their user", async () => {
		mocks.userId = "viewer-1";

		await track({ videoId: "video-1", sessionId: "anonymous" });

		const [insert] = inserts();
		expect(insert?.params.slice(3, 6)).toEqual([
			"user:viewer-1",
			"viewer-1",
			null,
		]);
	});

	it("collapses sessionless anonymous viewers into one row without a name", async () => {
		await track({ videoId: "video-1", guestName: "Ada" });

		const [insert] = inserts();
		expect(insert?.params.slice(3, 6)).toEqual(["anon", null, null]);
	});

	it("skips the owner's own views", async () => {
		mocks.userId = "owner-1";

		await track({ videoId: "video-1", sessionId: "session-1" });

		expect(inserts()).toHaveLength(0);
	});

	it("skips views while an upload is still active", async () => {
		mocks.video.activeUploadVideoId = "video-1";

		await track({ videoId: "video-1", sessionId: "session-1" });

		expect(inserts()).toHaveLength(0);
	});

	it("rejects oversized payloads before touching the database", async () => {
		const response = await track({
			videoId: "video-1",
			sessionId: "session-1",
			referrer: "x".repeat(20_000),
		});

		expect(response.status).toBe(413);
		expect(mocks.query).not.toHaveBeenCalled();
	});
});

describe("POST /api/analytics/track with Tinybird", () => {
	it("keeps sending events to Tinybird and skips MySQL", async () => {
		mocks.tinybirdEnabled = true;

		await track({ videoId: "video-1", sessionId: "session-1" });

		expect(mocks.appendEvents).toHaveBeenCalledTimes(1);
		expect(inserts()).toHaveLength(0);
	});
});
