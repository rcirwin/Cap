import { buildEnv, serverEnv } from "@cap/env";
import { render } from "@react-email/render";
import nodemailer, { type Transporter } from "nodemailer";
import type { JSXElementConstructor, ReactElement } from "react";
import { type CreateEmailResponse, Resend } from "resend";

const configured = (value: string | undefined) => value?.trim() || undefined;

export const resend = () => {
	const apiKey = configured(serverEnv().RESEND_API_KEY);
	return apiKey ? new Resend(apiKey) : null;
};

let smtpCache: { url: string; transport: Transporter } | null = null;

const smtp = () => {
	const url = configured(serverEnv().SMTP_URL);
	if (!url) return null;
	if (smtpCache?.url !== url) {
		smtpCache = { url, transport: nodemailer.createTransport(url) };
	}
	return smtpCache.transport;
};

export const isEmailConfigured = () =>
	Boolean(
		configured(serverEnv().RESEND_API_KEY) || configured(serverEnv().SMTP_URL),
	);

export const smtpFromAddress = (smtpUrl: string, emailFrom?: string) => {
	const explicit = configured(emailFrom);
	if (explicit) return explicit;
	try {
		const user = decodeURIComponent(new URL(smtpUrl).username);
		if (user.includes("@")) return `Cap <${user}>`;
	} catch {}
	return undefined;
};

type EmailAttachment = {
	filename: string;
	content: Buffer | string;
	contentType?: string;
};

const sendWithSmtp = async (
	transport: Transporter,
	{
		email,
		subject,
		react,
		cc,
		replyTo,
		attachments,
	}: {
		email: string;
		subject: string;
		react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
		cc?: string | string[];
		replyTo?: string;
		attachments?: EmailAttachment[];
	},
): Promise<CreateEmailResponse> => {
	const env = serverEnv();
	const from = smtpFromAddress(env.SMTP_URL ?? "", env.EMAIL_FROM);
	if (!from) {
		return {
			data: null,
			error: {
				name: "invalid_from_address",
				message:
					"Set EMAIL_FROM (or use an email address as the SMTP username)",
			},
		};
	}

	try {
		const [html, text] = await Promise.all([
			render(react),
			render(react, { plainText: true }),
		]);
		const info = await transport.sendMail({
			from,
			to: email,
			cc,
			replyTo,
			subject,
			html,
			text,
			attachments,
		});
		return { data: { id: info.messageId }, error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[email] SMTP delivery to ${email} failed: ${message}`);
		return { data: null, error: { name: "application_error", message } };
	}
};

export const sendEmail = async ({
	email,
	subject,
	react,
	marketing,
	test,
	scheduledAt,
	cc,
	replyTo,
	fromOverride,
	idempotencyKey,
	attachments,
}: {
	email: string;
	subject: string;
	react: ReactElement<unknown, string | JSXElementConstructor<unknown>>;
	marketing?: boolean;
	test?: boolean;
	scheduledAt?: string;
	cc?: string | string[];
	replyTo?: string;
	fromOverride?: string;
	idempotencyKey?: string;
	attachments?: EmailAttachment[];
}) => {
	const r = resend();
	if (!r) {
		if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;
		const transport = smtp();
		if (!transport || test) return;
		return sendWithSmtp(transport, {
			email,
			subject,
			react,
			cc,
			replyTo,
			attachments,
		});
	}

	if (marketing && !buildEnv.NEXT_PUBLIC_IS_CAP) return;
	let from: string;

	if (fromOverride) from = fromOverride;
	else if (marketing) from = "Richie from Cap <richie@send.cap.so>";
	else if (buildEnv.NEXT_PUBLIC_IS_CAP)
		from = "Cap Auth <no-reply@auth.cap.so>";
	else from = `auth@${serverEnv().RESEND_FROM_DOMAIN}`;

	return r.emails.send(
		{
			from,
			to: test ? "delivered@resend.dev" : email,
			subject,
			react,
			scheduledAt,
			cc: test ? undefined : cc,
			replyTo: replyTo,
			attachments,
		},
		idempotencyKey ? { idempotencyKey } : undefined,
	);
};
