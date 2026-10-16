"use client";

// type-only on purpose: a value import of @cap/web-domain drags the whole
// effect runtime into the share page's entry chunk.
import type { Comment, User, Video } from "@cap/web-domain";
import clsx from "clsx";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	type NewGuestCommentResult,
	newGuestComment,
} from "@/actions/videos/new-guest-comment";
import { readStoredGuestName, storeGuestName } from "@/lib/guest-name";
import type { CommentType } from "../../Share";
import { AuthOverlay } from "../AuthOverlayLazy";
import { GuestNameDialog } from "./GuestNameDialog";

export type GuestCommentsConfig = {
	comments: boolean;
	reactions: boolean;
	guestId: string | null;
};

export type GuestCommentDraft = {
	videoId: Video.VideoId;
	type: "text" | "emoji";
	content: string;
	parentCommentId: Comment.CommentId;
	timestamp: number | null;
};

type GuestCommentHandlers = {
	onOptimistic?: (comment: CommentType) => void;
	onSuccess?: (comment: CommentType) => void;
};

type GuestCommentsContextValue = {
	canComment: boolean;
	canReact: boolean;
	guestId: string | null;
	guestName: string | null;
	error: string | null;
	ensureName: () => Promise<string | null>;
	changeName: () => void;
	requestSignIn: () => void;
	postComment: (
		draft: GuestCommentDraft,
		handlers?: GuestCommentHandlers,
	) => Promise<CommentType | null>;
};

const POST_FAILED_ERROR = "Couldn't post your comment. Please try again.";

const GuestCommentsContext = createContext<GuestCommentsContextValue | null>(
	null,
);

/** Null unless the page enabled commenting for this signed-out viewer. */
export const useGuestComments = () => useContext(GuestCommentsContext);

export function GuestCommentsProvider({
	config,
	children,
}: {
	config: GuestCommentsConfig | null;
	children: ReactNode;
}) {
	if (!config) return children;
	return (
		<ActiveGuestCommentsProvider config={config}>
			{children}
		</ActiveGuestCommentsProvider>
	);
}

function ActiveGuestCommentsProvider({
	config,
	children,
}: {
	config: GuestCommentsConfig;
	children: ReactNode;
}) {
	const [guestName, setGuestName] = useState<string | null>(null);
	const [guestId, setGuestId] = useState<string | null>(config.guestId);
	const [error, setError] = useState<string | null>(null);
	const [nameDialog, setNameDialog] = useState({
		open: false,
		initialName: "",
	});
	const [showAuthOverlay, setShowAuthOverlay] = useState(false);
	const guestNameRef = useRef<string | null>(null);
	const guestIdRef = useRef<string | null>(config.guestId);
	const pendingNameRef = useRef<((name: string | null) => void) | null>(null);

	useEffect(() => {
		const stored = readStoredGuestName();
		guestNameRef.current = stored;
		setGuestName(stored);
	}, []);

	const settlePendingName = useCallback((name: string | null) => {
		const resolve = pendingNameRef.current;
		pendingNameRef.current = null;
		resolve?.(name);
	}, []);

	const ensureName = useCallback(() => {
		if (guestNameRef.current) return Promise.resolve(guestNameRef.current);
		return new Promise<string | null>((resolve) => {
			pendingNameRef.current?.(null);
			pendingNameRef.current = resolve;
			setNameDialog({ open: true, initialName: "" });
		});
	}, []);

	const changeName = useCallback(() => {
		setNameDialog({ open: true, initialName: guestNameRef.current ?? "" });
	}, []);

	const submitName = useCallback(
		(value: string) => {
			const name = storeGuestName(value);
			if (!name) return;
			guestNameRef.current = name;
			setGuestName(name);
			setError(null);
			setNameDialog((current) => ({ ...current, open: false }));
			settlePendingName(name);
		},
		[settlePendingName],
	);

	const dismissNameDialog = useCallback(() => {
		setNameDialog((current) => ({ ...current, open: false }));
		settlePendingName(null);
	}, [settlePendingName]);

	const requestSignIn = useCallback(() => {
		dismissNameDialog();
		setShowAuthOverlay(true);
	}, [dismissNameDialog]);

	const postComment = useCallback(
		async (draft: GuestCommentDraft, handlers?: GuestCommentHandlers) => {
			const name = await ensureName();
			if (!name) return null;

			const now = new Date();
			handlers?.onOptimistic?.({
				id: `temp-${now.getTime()}` as Comment.CommentId,
				authorId: (guestIdRef.current ?? "guest") as User.UserId,
				authorName: name,
				authorImage: null,
				guestName: name,
				content: draft.content,
				createdAt: now,
				updatedAt: now,
				videoId: draft.videoId,
				parentCommentId: draft.parentCommentId,
				type: draft.type,
				timestamp: draft.timestamp,
				mediaKey: null,
				mediaDuration: null,
				mediaMeta: null,
				sending: true,
			});
			setError(null);

			let result: NewGuestCommentResult;
			try {
				result = await newGuestComment({ ...draft, guestName: name });
			} catch {
				result = { success: false, error: POST_FAILED_ERROR };
			}

			if (!result.success) {
				setError(result.error);
				toast.error(result.error);
				return null;
			}

			guestIdRef.current = result.guestId;
			setGuestId(result.guestId);
			handlers?.onSuccess?.(result.comment);
			return result.comment;
		},
		[ensureName],
	);

	const value = useMemo<GuestCommentsContextValue>(
		() => ({
			canComment: config.comments,
			canReact: config.reactions,
			guestId,
			guestName,
			error,
			ensureName,
			changeName,
			requestSignIn,
			postComment,
		}),
		[
			config.comments,
			config.reactions,
			guestId,
			guestName,
			error,
			ensureName,
			changeName,
			requestSignIn,
			postComment,
		],
	);

	return (
		<GuestCommentsContext.Provider value={value}>
			{children}
			<GuestNameDialog
				open={nameDialog.open}
				initialName={nameDialog.initialName}
				onSubmit={submitName}
				onDismiss={dismissNameDialog}
				onSignIn={requestSignIn}
			/>
			<AuthOverlay
				isOpen={showAuthOverlay}
				onClose={() => setShowAuthOverlay(false)}
			/>
		</GuestCommentsContext.Provider>
	);
}

/** "Commenting as {name} · change", the sign-in escape hatch, and any failure. */
export function GuestIdentityBar({ className }: { className?: string }) {
	const guest = useGuestComments();
	if (!guest) return null;

	return (
		<div className={clsx("space-y-1 text-xs", className)}>
			<div className="flex gap-2 justify-between items-center text-gray-10">
				<p className="min-w-0 truncate">
					{guest.guestName ? (
						<>
							Commenting as{" "}
							<span className="font-medium text-gray-12">
								{guest.guestName}
							</span>
							{" · "}
							<button
								type="button"
								onClick={guest.changeName}
								className="text-blue-9 hover:underline"
							>
								change
							</button>
						</>
					) : (
						"Comment as a guest, no account needed"
					)}
				</p>
				<button
					type="button"
					onClick={guest.requestSignIn}
					className="font-medium shrink-0 text-gray-10 transition-colors hover:text-gray-12"
				>
					Sign in
				</button>
			</div>
			{guest.error && (
				<p role="alert" className="text-red-500">
					{guest.error}
				</p>
			)}
		</div>
	);
}
