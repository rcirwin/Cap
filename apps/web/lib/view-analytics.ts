import { serverEnv } from "@cap/env";

export const MAX_TRACK_PAYLOAD_LENGTH = 16 * 1024;

const UNKNOWN_COUNTRY_CODE = "XX";

export const isTinybirdConfigured = () => {
	const env = serverEnv();
	return Boolean(env.TINYBIRD_TOKEN && env.TINYBIRD_HOST);
};

export const isMySqlViewAnalyticsActive = () => !isTinybirdConfigured();

export const isViewAnalyticsEnabled = () =>
	isTinybirdConfigured() || isMySqlViewAnalyticsActive();

export const sanitizeTrackValue = (value?: string | null) => {
	const trimmed = value?.trim();
	return trimmed && trimmed !== "unknown" ? trimmed.slice(0, 256) : undefined;
};

export const decodeHeaderValue = (value?: string | null) => {
	if (!value) return value;
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
};

export const readViewerGeo = (headers: Headers) => {
	const cloudflareCountry = sanitizeTrackValue(headers.get("cf-ipcountry"));
	return {
		country:
			sanitizeTrackValue(headers.get("x-vercel-ip-country")) ||
			(cloudflareCountry?.toUpperCase() === UNKNOWN_COUNTRY_CODE
				? undefined
				: cloudflareCountry) ||
			"",
		region:
			sanitizeTrackValue(headers.get("x-vercel-ip-country-region")) ||
			sanitizeTrackValue(headers.get("cf-region-code")) ||
			"",
		city:
			sanitizeTrackValue(decodeHeaderValue(headers.get("x-vercel-ip-city"))) ||
			sanitizeTrackValue(decodeHeaderValue(headers.get("cf-ipcity"))) ||
			"",
	};
};

export const readViewerIp = (headers: Headers) =>
	headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
	headers.get("x-real-ip")?.trim() ||
	headers.get("cf-connecting-ip")?.trim() ||
	null;

export const createViewThrottle = (options: {
	limit: number;
	windowMs: number;
	maxKeys: number;
}) => {
	const windows = new Map<string, { count: number; resetAt: number }>();

	return (key: string, now = Date.now()) => {
		const current = windows.get(key);
		if (current && current.resetAt > now) {
			if (current.count >= options.limit) return false;
			current.count += 1;
			return true;
		}

		if (!current && windows.size >= options.maxKeys) {
			for (const [entryKey, entry] of windows) {
				if (entry.resetAt <= now) windows.delete(entryKey);
			}
			if (windows.size >= options.maxKeys) windows.clear();
		}

		windows.set(key, { count: 1, resetAt: now + options.windowMs });
		return true;
	};
};
