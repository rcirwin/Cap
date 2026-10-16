import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatBucketLabel } from "@/app/(org)/dashboard/analytics/bucket-label";

describe("formatBucketLabel", () => {
	const originalTz = process.env.TZ;

	beforeEach(() => {
		process.env.TZ = "America/Toronto";
	});

	afterEach(() => {
		process.env.TZ = originalTz;
	});

	it("labels a daily UTC bucket with its own date west of Greenwich", () => {
		expect(formatBucketLabel("2026-10-16T00:00:00Z", false)).toBe(
			new Date(Date.UTC(2026, 9, 16)).toLocaleDateString([], {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			}),
		);
		expect(formatBucketLabel("2026-10-16T00:00:00Z", false)).toContain("16");
	});

	it("keeps hourly buckets in the viewer's local time", () => {
		const bucket = "2026-10-16T17:00:00Z";
		expect(formatBucketLabel(bucket, true)).toBe(
			new Date(bucket).toLocaleTimeString([], { hour: "numeric" }),
		);
	});

	it("returns unparseable buckets unchanged", () => {
		expect(formatBucketLabel("not-a-date", false)).toBe("not-a-date");
	});
});
