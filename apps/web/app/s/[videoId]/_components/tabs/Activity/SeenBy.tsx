"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@cap/ui";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { getVideoViewers } from "@/actions/videos/get-video-viewers";
import { AnimalAvatar } from "@/components/AnimalAvatar";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import type { VideoViewer, VideoViewersResult } from "@/lib/video-viewers";
import { formatTimeAgo, formatTimestamp } from "./utils";

const AVATAR_STACK_SIZE = 2;

const ViewerAvatar = ({
	viewer,
	className,
}: {
	viewer: VideoViewer;
	className: string;
}) =>
	viewer.kind === "anonymous" ? (
		<AnimalAvatar name={viewer.name} className={className} />
	) : (
		<SignedImageUrl
			image={viewer.image}
			name={viewer.name}
			className={className}
			letterClass="text-[10px]"
		/>
	);

const describeViewer = (viewer: VideoViewer) => {
	const client = [viewer.browser, viewer.os].filter(Boolean).join(" on ");
	const visits = viewer.sessions > 1 ? `${viewer.sessions} visits` : null;
	return [client || viewer.device, viewer.location, visits]
		.filter(Boolean)
		.join(" · ");
};

export const SeenBy = ({ videoId }: { videoId: string }) => {
	const [result, setResult] = useState<VideoViewersResult | null>(null);

	useEffect(() => {
		let active = true;
		getVideoViewers(videoId)
			.then((data) => {
				if (active) setResult(data);
			})
			.catch((error) => {
				console.error("Error fetching video viewers:", error);
			});
		return () => {
			active = false;
		};
	}, [videoId]);

	if (!result || result.total === 0) return null;

	const label = `Seen by ${result.total} ${result.total === 1 ? "person" : "people"}`;
	const hiddenCount = result.total - result.viewers.length;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={label}
					title={label}
					className="flex shrink-0 gap-1.5 items-center py-0.5 pr-1.5 pl-0.5 text-xs rounded-full transition-colors text-gray-11 hover:bg-gray-3 hover:text-gray-12"
				>
					<span className="flex -space-x-1.5">
						{result.viewers.slice(0, AVATAR_STACK_SIZE).map((viewer) => (
							<ViewerAvatar
								key={viewer.id}
								viewer={viewer}
								className="rounded-full ring-2 size-5 ring-gray-1"
							/>
						))}
					</span>
					<span>{result.total}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="p-0 w-72 border bg-gray-1 border-gray-4"
			>
				<p className="px-4 pt-3 pb-2 text-sm font-medium text-gray-12">
					{label}
				</p>
				<ul className="overflow-y-auto pb-2 max-h-80">
					{result.viewers.map((viewer) => {
						const viewedAt = new Date(viewer.viewedAt);
						const detail = describeViewer(viewer);
						return (
							<li
								key={viewer.id}
								className="flex gap-2.5 items-center px-4 py-1.5"
							>
								<ViewerAvatar viewer={viewer} className="size-6 shrink-0" />
								<div className="flex-1 min-w-0">
									<p
										className={clsx(
											"text-sm truncate",
											viewer.kind === "anonymous"
												? "italic text-gray-10"
												: "text-gray-12",
										)}
									>
										{viewer.name}
										{viewer.kind === "guest" && (
											<span className="ml-1.5 text-xs not-italic text-gray-9">
												Guest
											</span>
										)}
									</p>
									{detail && (
										<p className="text-xs truncate text-gray-9">{detail}</p>
									)}
								</div>
								<time
									dateTime={viewedAt.toISOString()}
									title={formatTimestamp(viewedAt)}
									className="text-xs shrink-0 text-gray-9"
								>
									{formatTimeAgo(viewedAt)}
								</time>
							</li>
						);
					})}
				</ul>
				{hiddenCount > 0 && (
					<p className="px-4 pb-3 text-xs text-gray-9">
						and {hiddenCount} more
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
};
