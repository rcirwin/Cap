"use client";

import type { Video } from "@cap/web-domain";
import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { CommentType } from "../../../Share";
import { GuestIdentityBar, useGuestComments } from "../../guest/GuestComments";
import { RecordActionButtons } from "../../media-comment/record-actions";
import { useOptionalPlayback } from "../../playback/PlaybackContext";
import type { RecordIntentKind } from "../../timeline/TimelineComposer";
import CommentInput from "./CommentInput";

// Same deal as the timeline: capture and upload code only loads once someone
// presses record.
const RecorderSurface = dynamic(
	() => import("../../timeline/recording/RecorderSurface"),
	{ ssr: false },
);

interface ActivityComposerProps {
	videoId: Video.VideoId;
	/** Whose video this is, for the placeholder. */
	ownerName?: string | null;
	disabled?: boolean;
	onSubmit: (content: string) => void;
	setShowAuthOverlay: (show: boolean) => void;
	/** Owner is on Pro and the viewer is signed in; the upload path re-checks. */
	canRecordMedia?: boolean;
	onOptimisticComment?: (comment: CommentType) => void;
	onCommentSuccess?: (comment: CommentType) => void;
}

/**
 * The panel's composer, pinned above the comment list. Leading with it (rather
 * than parking it under the scroll) means the primary action is the first thing
 * in the sidebar and an empty panel reads as an invitation.
 */
export function ActivityComposer({
	videoId,
	ownerName,
	disabled,
	onSubmit,
	setShowAuthOverlay,
	canRecordMedia = false,
	onOptimisticComment,
	onCommentSuccess,
}: ActivityComposerProps) {
	const user = useCurrentUser();
	const guestComments = useGuestComments();
	const guest = user ? null : guestComments;
	const playback = useOptionalPlayback();
	const [recordIntent, setRecordIntent] = useState<{
		kind: RecordIntentKind;
		t: number;
	} | null>(null);
	const [focusAfterNaming, setFocusAfterNaming] = useState(false);

	const startRecording = useCallback(
		(kind: RecordIntentKind) => {
			// Anchor to wherever the viewer is watching, same as a text comment,
			// and get out of the way of whatever they are about to record.
			const t = playback?.getCurrentTime() ?? 0;
			playback?.pause();
			setRecordIntent({ kind, t });
		},
		[playback],
	);

	const placeholder = ownerName
		? `Respond to ${ownerName}...`
		: "Leave a comment";

	if (!user && guest?.canComment) {
		return (
			<div className="space-y-2">
				{guest.guestName ? (
					<CommentInput
						collapsible
						autoFocus={focusAfterNaming}
						onSubmit={onSubmit}
						disabled={disabled}
						placeholder={placeholder}
						buttonLabel="Comment"
						avatar={
							<SignedImageUrl
								image={null}
								name={guest.guestName}
								className="size-7 rounded-full"
								letterClass="text-[11px] font-medium"
							/>
						}
					/>
				) : (
					<ComposerInvitation
						placeholder={placeholder}
						action="Add your name"
						disabled={disabled}
						onClick={async () => {
							if (await guest.ensureName()) setFocusAfterNaming(true);
						}}
					/>
				)}
				<GuestIdentityBar className="px-1" />
			</div>
		);
	}

	// Signed out: the same shape as the real composer rather than a solid
	// sign-in bar, so the panel still opens on an invitation to write.
	if (!user) {
		return (
			<ComposerInvitation
				placeholder={placeholder}
				action="Sign in"
				onClick={() => setShowAuthOverlay(true)}
			/>
		);
	}

	return (
		<>
			<CommentInput
				collapsible
				onSubmit={onSubmit}
				disabled={disabled}
				placeholder={placeholder}
				buttonLabel="Comment"
				avatar={
					<SignedImageUrl
						image={user.imageUrl}
						name={user.name ?? "You"}
						className="size-7 rounded-full"
						letterClass="text-[11px] font-medium"
					/>
				}
				actions={
					canRecordMedia ? (
						<RecordActionButtons
							disabled={disabled}
							onSelect={startRecording}
						/>
					) : null
				}
			/>

			{recordIntent && (
				<RecorderSurface
					kind={recordIntent.kind}
					timestamp={recordIntent.t}
					videoId={videoId}
					onOptimisticComment={onOptimisticComment}
					onCommentSuccess={onCommentSuccess}
					onClose={() => setRecordIntent(null)}
					// The sidebar's tab pane clips overflow; an anchored card would
					// render above it, invisible (with a very live microphone).
					placement="floating"
				/>
			)}
		</>
	);
}

function ComposerInvitation({
	placeholder,
	action,
	disabled,
	onClick,
}: {
	placeholder: string;
	action: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className="flex w-full items-center gap-2 p-2 text-left rounded-lg border transition-colors bg-gray-1 border-gray-5 hover:border-gray-6"
		>
			<span className="flex justify-center items-center rounded-full size-7 shrink-0 bg-gray-4 text-gray-10">
				<svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
					<title>Viewer</title>
					<path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0 1.2c-2.6 0-4.8 1.5-4.8 3.3 0 .6.5 1 1.1 1h7.4c.6 0 1.1-.4 1.1-1 0-1.8-2.2-3.3-4.8-3.3Z" />
				</svg>
			</span>
			<span className="flex-1 text-sm truncate text-gray-8">{placeholder}</span>
			<span className="text-xs font-medium shrink-0 text-blue-9">{action}</span>
		</button>
	);
}
