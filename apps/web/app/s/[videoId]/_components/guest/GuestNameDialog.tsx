"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@cap/ui";
import { faUser } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useId, useState } from "react";
import { GUEST_NAME_MAX_LENGTH, normalizeGuestName } from "@/lib/guest-name";

export function GuestNameDialog({
	open,
	initialName,
	onSubmit,
	onDismiss,
	onSignIn,
}: {
	open: boolean;
	initialName: string;
	onSubmit: (name: string) => void;
	onDismiss: () => void;
	onSignIn: () => void;
}) {
	const inputId = useId();
	const [value, setValue] = useState(initialName);
	const name = normalizeGuestName(value);

	useEffect(() => {
		if (open) setValue(initialName);
	}, [open, initialName]);

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (name) onSubmit(name);
					}}
				>
					<DialogHeader
						icon={<FontAwesomeIcon icon={faUser} />}
						description="Shown next to your comments and reactions. No account needed."
					>
						<DialogTitle className="text-lg text-gray-12">
							What's your name?
						</DialogTitle>
					</DialogHeader>
					<div className="p-5 space-y-2">
						<label
							htmlFor={inputId}
							className="text-sm font-medium text-gray-12"
						>
							Display name
						</label>
						<Input
							id={inputId}
							value={value}
							maxLength={GUEST_NAME_MAX_LENGTH}
							autoComplete="name"
							placeholder="e.g. Alex from Design"
							onChange={(event) => setValue(event.target.value)}
						/>
					</div>
					<DialogFooter className="sm:items-center sm:justify-between">
						<button
							type="button"
							onClick={onSignIn}
							className="mt-2 text-xs text-gray-10 transition-colors hover:text-gray-12 sm:mt-0"
						>
							Have an account? Sign in
						</button>
						<div className="flex gap-2 justify-end">
							<Button
								type="button"
								variant="gray"
								size="sm"
								onClick={onDismiss}
							>
								Cancel
							</Button>
							<Button type="submit" variant="dark" size="sm" disabled={!name}>
								Continue
							</Button>
						</div>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
