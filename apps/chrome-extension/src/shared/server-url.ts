const CAP_CLOUD_BASE_URL = "https://cap.so";

const normalizeBaseUrl = (value: string | undefined) => {
	const trimmed = value?.trim().replace(/\/+$/, "");
	if (!trimmed) return null;
	try {
		return new URL(trimmed).origin;
	} catch {
		return null;
	}
};

export const PRODUCTION_API_BASE_URL =
	normalizeBaseUrl(import.meta.env.VITE_CAP_API_BASE_URL) ?? CAP_CLOUD_BASE_URL;

export const PRODUCTION_API_HOSTNAME = new URL(PRODUCTION_API_BASE_URL)
	.hostname;
