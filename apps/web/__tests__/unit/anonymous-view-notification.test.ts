import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	existing: null as null | { id: string; data: Record<string, unknown> },
}));

vi.mock("server-only", () => ({}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const client = drizzle(mocks.query);
	return { db: () => client };
});

vi.mock("@cap/database/emails/config", () => ({ sendEmail: vi.fn() }));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.example.com" }),
}));

const { createAnonymousViewNotification } = await import("@/lib/Notification");

const statements = () =>
	mocks.query.mock.calls.map(([sql, params]) => ({
		sql: String(sql),
		params: params as unknown[],
	}));

beforeEach(() => {
	mocks.existing = null;
	mocks.query.mockReset();
	mocks.query.mockImplementation(async (sql: string) => {
		if (sql.startsWith("select") && sql.includes("`dedupKey`")) {
			return {
				rows: mocks.existing ? [[mocks.existing.id, mocks.existing.data]] : [],
			};
		}
		if (sql.startsWith("select")) return { rows: [] };
		return { rows: [{ affectedRows: 1, insertId: 0 }] };
	});
});

describe("createAnonymousViewNotification", () => {
	it("renames an existing view notification once the guest gives a name", async () => {
		mocks.existing = {
			id: "notif-1",
			data: { videoId: "video-1", anonName: "Anonymous Sloth", location: null },
		};

		await createAnonymousViewNotification({
			videoId: "video-1",
			sessionId: "session-1",
			anonName: "Guest Test",
			location: null,
			isGuestName: true,
		});

		const update = statements().find((s) =>
			s.sql.startsWith("update `notifications`"),
		);
		expect(update).toBeDefined();
		expect(JSON.parse(String(update?.params[0]))).toEqual({
			videoId: "video-1",
			anonName: "Guest Test",
			location: null,
		});
		expect(update?.params).toContain("notif-1");
		expect(statements().some((s) => s.sql.startsWith("insert"))).toBe(false);
	});

	it("leaves an existing notification alone for unnamed repeat views", async () => {
		mocks.existing = {
			id: "notif-1",
			data: { videoId: "video-1", anonName: "Anonymous Sloth", location: null },
		};

		await createAnonymousViewNotification({
			videoId: "video-1",
			sessionId: "session-1",
			anonName: "Anonymous Sloth",
			location: null,
		});

		expect(
			statements().some(
				(s) => s.sql.startsWith("update") || s.sql.startsWith("insert"),
			),
		).toBe(false);
	});

	it("does not rewrite a notification that already has the guest's name", async () => {
		mocks.existing = {
			id: "notif-1",
			data: { videoId: "video-1", anonName: "Guest Test", location: null },
		};

		await createAnonymousViewNotification({
			videoId: "video-1",
			sessionId: "session-1",
			anonName: "Guest Test",
			location: null,
			isGuestName: true,
		});

		expect(statements().some((s) => s.sql.startsWith("update"))).toBe(false);
	});
});
