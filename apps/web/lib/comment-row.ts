import type { comments } from "@cap/database/schema";

export type CommentRow = Omit<
	typeof comments.$inferSelect,
	"guestName" | "guestIpHash"
> & {
	guestName?: string | null;
};
