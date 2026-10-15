import { serverEnv } from "@cap/env";

export type TranscriptionProviderId = "assemblyai" | "openai-compatible";

export const GROQ_TRANSCRIPTION_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL =
	"whisper-large-v3-turbo";

export interface AssemblyAITranscriptionConfig {
	provider: "assemblyai";
	apiKey: string;
}

export interface OpenAICompatibleTranscriptionConfig {
	provider: "openai-compatible";
	baseUrl: string;
	apiKey: string | null;
	model: string;
}

export type TranscriptionConfig =
	| AssemblyAITranscriptionConfig
	| OpenAICompatibleTranscriptionConfig;

export interface TranscriptionWord {
	text: string;
	start: number;
	end: number;
	confidence?: number | null;
	speaker?: string | null;
	channel?: string | null;
}

export interface TranscriptionResult {
	words: TranscriptionWord[];
	language_code: string | null;
	speech_model_used: string | null;
	audio_duration: number | null;
}

export class NoSpokenAudioError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NoSpokenAudioError";
	}
}

let warnedUnusableProvider = false;

function warnUnusableProvider(message: string) {
	if (warnedUnusableProvider) return;
	warnedUnusableProvider = true;
	console.warn(`[transcription] ${message}`);
}

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function isGroqBaseUrl(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === "api.groq.com";
	} catch {
		return false;
	}
}

export function getTranscriptionConfig(): TranscriptionConfig | null {
	const env = serverEnv();
	const assemblyApiKey = nonEmpty(env.ASSEMBLY_API_KEY);
	const baseUrlOverride = nonEmpty(env.TRANSCRIPTION_BASE_URL);
	const transcriptionApiKey = nonEmpty(env.TRANSCRIPTION_API_KEY);
	const groqApiKey = nonEmpty(env.GROQ_API_KEY);

	const provider: TranscriptionProviderId | null =
		env.TRANSCRIPTION_PROVIDER ||
		(assemblyApiKey
			? "assemblyai"
			: baseUrlOverride || transcriptionApiKey || groqApiKey
				? "openai-compatible"
				: null);

	if (provider === "assemblyai") {
		if (!assemblyApiKey) {
			warnUnusableProvider(
				"TRANSCRIPTION_PROVIDER is 'assemblyai' but ASSEMBLY_API_KEY is not set; transcription is disabled",
			);
			return null;
		}
		return { provider, apiKey: assemblyApiKey };
	}

	if (provider !== "openai-compatible") return null;

	const baseUrl = (baseUrlOverride ?? GROQ_TRANSCRIPTION_BASE_URL).replace(
		/\/+$/,
		"",
	);
	// GROQ_API_KEY is only ever sent to Groq itself: a custom base URL (OpenAI,
	// a local Whisper server, ...) must not receive another provider's key.
	const apiKey =
		transcriptionApiKey ??
		(isGroqBaseUrl(baseUrl) ? groqApiKey : undefined) ??
		null;

	if (!baseUrlOverride && !apiKey) {
		warnUnusableProvider(
			"TRANSCRIPTION_PROVIDER is 'openai-compatible' but neither TRANSCRIPTION_BASE_URL nor an API key (TRANSCRIPTION_API_KEY or GROQ_API_KEY) is set; transcription is disabled",
		);
		return null;
	}

	return {
		provider,
		baseUrl,
		apiKey,
		model:
			nonEmpty(env.TRANSCRIPTION_MODEL) ??
			DEFAULT_OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL,
	};
}

export function getTranscriptionProvider(): TranscriptionProviderId | null {
	return getTranscriptionConfig()?.provider ?? null;
}

export function isTranscriptionConfigured(): boolean {
	return getTranscriptionConfig() !== null;
}
