import { describe, expect, it } from "vitest";
import { resolveNotificationAuthor } from "@/lib/notification-author";

describe("resolveNotificationAuthor", () => {
	it("uses the joined user for signed-in authors", () => {
		expect(
			resolveNotificationAuthor({
				author: { id: "user-1", name: "Owner", avatar: "avatar-key" },
				data: { authorId: "user-1" },
			}),
		).toEqual({ id: "user-1", name: "Owner", avatar: "avatar-key" });
	});

	it("labels nameless users as Unknown", () => {
		expect(
			resolveNotificationAuthor({
				author: { id: "user-1", name: null, avatar: null },
				data: { authorId: "user-1" },
			}),
		).toEqual({ id: "user-1", name: "Unknown", avatar: null });
	});

	it("builds a guest author from the stored display name", () => {
		expect(
			resolveNotificationAuthor({
				author: null,
				data: { authorId: "Gabcdefghjkmnpq", anonName: "Ada" },
			}),
		).toEqual({ id: "Gabcdefghjkmnpq", name: "Ada", avatar: null });
	});

	it("drops notifications with no resolvable author", () => {
		expect(
			resolveNotificationAuthor({
				author: null,
				data: { authorId: "deleted-user" },
			}),
		).toBeNull();
		expect(
			resolveNotificationAuthor({ author: null, data: { anonName: "Ada" } }),
		).toBeNull();
	});
});
