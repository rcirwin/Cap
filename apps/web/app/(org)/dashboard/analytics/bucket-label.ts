// Daily buckets are UTC days keyed at midnight UTC, so their labels must be
// rendered in UTC; local formatting shows the previous day west of Greenwich.
// Hourly buckets map onto local hours exactly and stay in the viewer's zone.
export const formatBucketLabel = (bucket: string, hourly: boolean) => {
	const date = new Date(bucket);
	if (Number.isNaN(date.getTime())) return bucket;
	if (hourly)
		return date.toLocaleTimeString([], {
			hour: "numeric",
			minute: undefined,
		});
	return date.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
};
