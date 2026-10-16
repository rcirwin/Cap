import { buildEnv } from "@cap/env";

export const showCapMarketing = () => buildEnv.NEXT_PUBLIC_IS_CAP === "true";

export const capHomeHref = (ref: string) =>
	showCapMarketing() ? `/?ref=${ref}` : "/dashboard";
