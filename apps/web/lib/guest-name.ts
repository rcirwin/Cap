export const GUEST_NAME_STORAGE_KEY = "cap_guest_name";
export const GUEST_NAME_MAX_LENGTH = 64;

export const normalizeGuestName = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const name = value
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, GUEST_NAME_MAX_LENGTH)
		.trim();
	return name.length > 0 ? name : null;
};

export const readStoredGuestName = (): string | null => {
	try {
		return normalizeGuestName(
			window.localStorage.getItem(GUEST_NAME_STORAGE_KEY),
		);
	} catch {
		return null;
	}
};

export const storeGuestName = (value: string): string | null => {
	const name = normalizeGuestName(value);
	if (!name) return null;
	try {
		window.localStorage.setItem(GUEST_NAME_STORAGE_KEY, name);
	} catch {
		return name;
	}
	return name;
};
