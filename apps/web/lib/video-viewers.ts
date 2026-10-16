import type { ImageUpload, User } from "@cap/web-domain";
import type { OrganizationRole } from "@/lib/permissions/roles";

export const VIDEO_VIEWERS_LIMIT = 100;

export type VideoViewerKind = "user" | "guest" | "anonymous";

export interface VideoViewerRow {
	sessionId: string;
	viewerUserId: User.UserId | null;
	viewerName: string | null;
	userName: string | null;
	userImage: ImageUpload.ImageUrlOrKey | null;
	browser: string;
	os: string;
	device: string;
	country: string;
	city: string;
	viewedAt: Date;
}

export interface GroupedVideoViewer {
	key: string;
	name: string;
	kind: VideoViewerKind;
	imageKey: ImageUpload.ImageUrlOrKey | null;
	viewedAt: Date;
	sessions: number;
	browser: string | null;
	os: string | null;
	device: string | null;
	location: string | null;
}

export type VideoViewer = Omit<GroupedVideoViewer, "imageKey" | "key"> & {
	id: string;
	image: ImageUpload.ImageUrl | null;
};

export interface VideoViewersResult {
	total: number;
	viewers: VideoViewer[];
}

export const canSeeVideoViewers = ({
	viewerId,
	ownerId,
	organizationRole,
}: {
	viewerId: string;
	ownerId: string;
	organizationRole: OrganizationRole | null | undefined;
}) =>
	viewerId === ownerId ||
	organizationRole === "owner" ||
	organizationRole === "admin";

const knownValue = (value: string | null | undefined) => {
	const trimmed = value?.trim();
	return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : null;
};

const formatLocation = (city: string, country: string) => {
	const parts = [knownValue(city), knownValue(country)].filter(
		(part): part is string => part !== null,
	);
	return parts.length > 0 ? parts.join(", ") : null;
};

export const resolveVideoViewerName = (
	row: Pick<VideoViewerRow, "sessionId" | "userName" | "viewerName">,
	anonymousName: (sessionId: string) => string,
): { name: string; kind: VideoViewerKind } => {
	const userName = row.userName?.trim();
	if (userName) return { name: userName, kind: "user" };
	const guestName = row.viewerName?.trim();
	if (guestName) return { name: guestName, kind: "guest" };
	return { name: anonymousName(row.sessionId), kind: "anonymous" };
};

export const groupVideoViewers = (
	rows: ReadonlyArray<VideoViewerRow>,
	anonymousName: (sessionId: string) => string,
): GroupedVideoViewer[] => {
	const viewers = new Map<string, GroupedVideoViewer>();

	for (const row of rows) {
		const key = row.viewerUserId
			? `user:${row.viewerUserId}`
			: `session:${row.sessionId}`;
		const existing = viewers.get(key);

		if (existing) {
			existing.sessions += 1;
			if (existing.kind === "anonymous") {
				const resolved = resolveVideoViewerName(row, anonymousName);
				if (resolved.kind !== "anonymous") {
					existing.name = resolved.name;
					existing.kind = resolved.kind;
				}
			}
			existing.imageKey ??= row.userImage;
			if (row.viewedAt.getTime() > existing.viewedAt.getTime()) {
				existing.viewedAt = row.viewedAt;
				existing.browser = knownValue(row.browser);
				existing.os = knownValue(row.os);
				existing.device = knownValue(row.device);
				existing.location = formatLocation(row.city, row.country);
			}
			continue;
		}

		viewers.set(key, {
			key,
			...resolveVideoViewerName(row, anonymousName),
			imageKey: row.userImage,
			viewedAt: row.viewedAt,
			sessions: 1,
			browser: knownValue(row.browser),
			os: knownValue(row.os),
			device: knownValue(row.device),
			location: formatLocation(row.city, row.country),
		});
	}

	return Array.from(viewers.values()).sort(
		(a, b) => b.viewedAt.getTime() - a.viewedAt.getTime(),
	);
};
