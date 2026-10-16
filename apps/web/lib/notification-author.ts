export type NotificationAuthor<Avatar> = {
	id: string;
	name: string;
	avatar: Avatar | null;
};

export function resolveNotificationAuthor<Avatar>({
	author,
	data,
}: {
	author: { id: string; name: string | null; avatar: Avatar | null } | null;
	data: { authorId?: string; anonName?: string };
}): NotificationAuthor<Avatar> | null {
	if (author?.id) {
		return {
			id: author.id,
			name: author.name ?? "Unknown",
			avatar: author.avatar,
		};
	}

	if (data.authorId && data.anonName) {
		return { id: data.authorId, name: data.anonName, avatar: null };
	}

	return null;
}
