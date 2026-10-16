import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	env: {
		RESEND_API_KEY: undefined as string | undefined,
		RESEND_FROM_DOMAIN: undefined as string | undefined,
		SMTP_URL: undefined as string | undefined,
		EMAIL_FROM: undefined as string | undefined,
	},
	buildEnv: { NEXT_PUBLIC_IS_CAP: undefined as string | undefined },
	sendMail: vi.fn(),
	createTransport: vi.fn(),
	resendSend: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => mocks.env,
	buildEnv: mocks.buildEnv,
}));

vi.mock("nodemailer", () => ({
	default: { createTransport: mocks.createTransport },
}));

vi.mock("@react-email/render", () => ({
	render: async (_element: unknown, options?: { plainText?: boolean }) =>
		options?.plainText ? "Hello" : "<p>Hello</p>",
}));

vi.mock("resend", () => ({
	Resend: class {
		emails = { send: mocks.resendSend };
	},
}));

const { isEmailConfigured, sendEmail, smtpFromAddress } = await import(
	"@cap/database/emails/config"
);

const message = createElement("p", null, "Hello");

describe("email transport", () => {
	beforeEach(() => {
		mocks.env.RESEND_API_KEY = undefined;
		mocks.env.SMTP_URL = undefined;
		mocks.env.EMAIL_FROM = undefined;
		mocks.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		mocks.sendMail.mockReset();
		mocks.resendSend.mockReset();
		mocks.createTransport.mockReset();
		mocks.createTransport.mockImplementation(() => ({
			sendMail: mocks.sendMail,
		}));
	});

	it("reports whether any provider is configured", () => {
		expect(isEmailConfigured()).toBe(false);
		mocks.env.SMTP_URL = "  ";
		expect(isEmailConfigured()).toBe(false);
		mocks.env.SMTP_URL = "smtps://me%40gmail.com:pw@smtp.gmail.com:465";
		expect(isEmailConfigured()).toBe(true);
		mocks.env.SMTP_URL = undefined;
		mocks.env.RESEND_API_KEY = "re_123";
		expect(isEmailConfigured()).toBe(true);
	});

	it("derives the from address from EMAIL_FROM or the SMTP username", () => {
		expect(
			smtpFromAddress("smtps://me%40gmail.com:pw@smtp.gmail.com:465"),
		).toBe("Cap <me@gmail.com>");
		expect(
			smtpFromAddress(
				"smtps://me%40gmail.com:pw@smtp.gmail.com:465",
				"Videos <videos@example.com>",
			),
		).toBe("Videos <videos@example.com>");
		expect(smtpFromAddress("smtp://apikey:secret@smtp.example.com:587")).toBe(
			undefined,
		);
		expect(smtpFromAddress("not a url")).toBe(undefined);
	});

	it("does nothing when no provider is configured", async () => {
		await expect(
			sendEmail({ email: "a@b.com", subject: "Hi", react: message }),
		).resolves.toBeUndefined();
		expect(mocks.createTransport).not.toHaveBeenCalled();
	});

	it("sends rendered HTML and text over SMTP in Resend's response shape", async () => {
		mocks.env.SMTP_URL = "smtps://me%40gmail.com:pw@smtp.gmail.com:465";
		mocks.sendMail.mockResolvedValue({ messageId: "<abc@gmail.com>" });

		const result = await sendEmail({
			email: "owner@example.com",
			subject: "New comment",
			react: message,
			replyTo: "reply@example.com",
			fromOverride: "Richie <richie@send.cap.so>",
		});

		expect(result).toEqual({ data: { id: "<abc@gmail.com>" }, error: null });
		expect(mocks.sendMail).toHaveBeenCalledWith(
			expect.objectContaining({
				from: "Cap <me@gmail.com>",
				to: "owner@example.com",
				subject: "New comment",
				replyTo: "reply@example.com",
				html: "<p>Hello</p>",
				text: "Hello",
			}),
		);
		expect(mocks.resendSend).not.toHaveBeenCalled();
	});

	it("returns an error result instead of throwing when SMTP fails", async () => {
		mocks.env.SMTP_URL = "smtps://me%40gmail.com:pw@smtp.gmail.com:465";
		mocks.sendMail.mockRejectedValue(new Error("Invalid login"));
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		const result = await sendEmail({
			email: "owner@example.com",
			subject: "Hi",
			react: message,
		});

		expect(result).toEqual({
			data: null,
			error: { name: "application_error", message: "Invalid login" },
		});
		consoleError.mockRestore();
	});

	it("skips marketing email on self-hosted builds", async () => {
		mocks.env.SMTP_URL = "smtps://me%40gmail.com:pw@smtp.gmail.com:465";
		await expect(
			sendEmail({
				email: "a@b.com",
				subject: "Promo",
				react: message,
				marketing: true,
			}),
		).resolves.toBeUndefined();
		expect(mocks.sendMail).not.toHaveBeenCalled();
	});

	it("prefers Resend when both providers are configured", async () => {
		mocks.env.SMTP_URL = "smtps://me%40gmail.com:pw@smtp.gmail.com:465";
		mocks.env.RESEND_API_KEY = "re_123";
		mocks.env.RESEND_FROM_DOMAIN = "example.com";
		mocks.resendSend.mockResolvedValue({ data: { id: "r1" }, error: null });

		await sendEmail({ email: "a@b.com", subject: "Hi", react: message });

		expect(mocks.resendSend).toHaveBeenCalledOnce();
		expect(mocks.sendMail).not.toHaveBeenCalled();
	});
});
