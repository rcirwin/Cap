import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	currentUser: null as { id: string } | null,
	organizationRole: null as "owner" | "admin" | "member" | null,
	tinybirdEnabled: false,
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.currentUser,
}));

vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: async () =>
		mocks.organizationRole ? { role: mocks.organizationRole } : null,
}));

vi.mock("@/lib/server", async () => {
	const { Effect, Layer } = await import("effect");
	const { ImageUploads, Tinybird, ViewAnalytics } = await import(
		"@cap/web-backend"
	);
	const { ImageUpload } = await import("@cap/web-domain");
	return {
		runPromise: <A, E>(
			effect: import("effect").Effect.Effect<
				A,
				E,
				| import("@cap/web-backend").Tinybird
				| import("@cap/web-backend").ViewAnalytics
				| import("@cap/web-backend").ImageUploads
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
									appendEvents: () => Effect.void,
									queryPipe: () => Effect.succeed({ data: [] }),
									querySql: () => Effect.succeed({ data: [] }),
									deleteData: () => Effect.void,
								}),
							),
							Layer.succeed(
								ImageUploads,
								ImageUploads.make({
									applyUpdate: () => Effect.die("unused"),
									resolveImageUrl: (key) =>
										Effect.succeed(
											ImageUpload.ImageUrl.make(`https://images.test/${key}`),
										),
								}),
							),
							ViewAnalytics.Default,
						),
					),
				),
			),
	};
});

import { getVideoViewers } from "@/actions/videos/get-video-viewers";

const viewerQueries = () =>
	mocks.query.mock.calls.filter(([sql]) =>
		String(sql).includes("from `video_views`"),
	);

beforeEach(() => {
	mocks.currentUser = null;
	mocks.organizationRole = null;
	mocks.tinybirdEnabled = false;
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql.includes("from `videos`")) {
			return { rows: [["owner-1", "org-1"]] };
		}
		if (sql.includes("COUNT(DISTINCT COALESCE")) {
			return { rows: [[3]] };
		}
		if (sql.includes("from `video_views`")) {
			return {
				rows: [
					[
						"s1",
						"user-1",
						null,
						"Grace Hopper",
						"avatars/grace.png",
						"Chrome",
						"macOS",
						"desktop",
						"CA",
						"Toronto",
						"2026-10-16 12:00:00",
					],
					[
						"s2",
						null,
						"Ada",
						null,
						null,
						"Firefox",
						"Windows",
						"desktop",
						"",
						"",
						"2026-10-16 11:00:00",
					],
					[
						"s3",
						"user-1",
						null,
						"Grace Hopper",
						"avatars/grace.png",
						"Safari",
						"iOS",
						"mobile",
						"",
						"",
						"2026-10-15 12:00:00",
					],
					[
						"s4",
						null,
						null,
						null,
						null,
						"Chrome",
						"Android",
						"mobile",
						"",
						"",
						"2026-10-14 12:00:00",
					],
				],
			};
		}
		return { rows: [] };
	});
});

describe("getVideoViewers", () => {
	it("lists grouped viewers for the video owner", async () => {
		mocks.currentUser = { id: "owner-1" };

		const result = await getVideoViewers("video-1");

		expect(result?.total).toBe(3);
		expect(
			result?.viewers.map(({ name, kind, sessions, image }) => ({
				name,
				kind,
				sessions,
				image,
			})),
		).toEqual([
			{
				name: "Grace Hopper",
				kind: "user",
				sessions: 2,
				image: "https://images.test/avatars/grace.png",
			},
			{ name: "Ada", kind: "guest", sessions: 1, image: null },
			{
				name: expect.stringMatching(/^Anonymous /),
				kind: "anonymous",
				sessions: 1,
				image: null,
			},
		]);
		expect(result?.viewers[0]?.viewedAt.toISOString()).toBe(
			"2026-10-16T12:00:00.000Z",
		);
		expect(JSON.stringify(result)).not.toContain("user-1");
		expect(JSON.stringify(result)).not.toContain("s4");
	});

	it("lets organization admins see viewers", async () => {
		mocks.currentUser = { id: "admin-1" };
		mocks.organizationRole = "admin";

		const result = await getVideoViewers("video-1");

		expect(result?.viewers).toHaveLength(3);
	});

	it.each([
		{ label: "a stranger", role: null },
		{ label: "a regular member", role: "member" as const },
	])("hides viewers from $label", async ({ role }) => {
		mocks.currentUser = { id: "someone-else" };
		mocks.organizationRole = role;

		expect(await getVideoViewers("video-1")).toBeNull();
		expect(viewerQueries()).toHaveLength(0);
	});

	it("hides viewers from signed-out visitors", async () => {
		expect(await getVideoViewers("video-1")).toBeNull();
		expect(mocks.query).not.toHaveBeenCalled();
	});

	it("returns nothing when Tinybird handles analytics", async () => {
		mocks.currentUser = { id: "owner-1" };
		mocks.tinybirdEnabled = true;

		expect(await getVideoViewers("video-1")).toBeNull();
		expect(viewerQueries()).toHaveLength(0);
	});
});
