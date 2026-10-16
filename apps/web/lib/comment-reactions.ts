export const COMMENT_REACTIONS = [
	{ emoji: "😂", label: "joy" },
	{ emoji: "😍", label: "love" },
	{ emoji: "😮", label: "wow" },
	{ emoji: "🙌", label: "yay" },
	{ emoji: "👍", label: "up" },
	{ emoji: "👎", label: "down" },
] as const;

export const isCommentReaction = (value: string) =>
	COMMENT_REACTIONS.some((reaction) => reaction.emoji === value);
