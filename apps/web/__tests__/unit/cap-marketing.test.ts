import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: undefined as string | undefined },
}));

vi.mock("@cap/env", () => ({
	buildEnv: mocks.buildEnv,
}));

const { capHomeHref, showCapMarketing } = await import("@/lib/cap-marketing");

describe("cap marketing", () => {
	beforeEach(() => {
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
	});

	it("shows marketing on Cap's hosted cloud", () => {
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = "true";

		expect(showCapMarketing()).toBe(true);
		expect(capHomeHref("video_abc123")).toBe("/?ref=video_abc123");
		expect(capHomeHref("collection")).toBe("/?ref=collection");
	});

	it("hides marketing on self-hosted builds", () => {
		expect(showCapMarketing()).toBe(false);
		expect(capHomeHref("video_abc123")).toBe("/dashboard");
	});

	it("only treats the exact hosted flag as Cap's cloud", () => {
		for (const value of ["", "false", "1"]) {
			mocks.buildEnv.NEXT_PUBLIC_IS_CAP = value;
			expect(showCapMarketing()).toBe(false);
			expect(capHomeHref("collection")).toBe("/dashboard");
		}
	});
});
