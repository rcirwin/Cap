import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
} from "@cap/web-domain";
import { prepareTranscriptionAudio } from "@/lib/transcription/audio-prep";
import type {
	OpenAICompatibleTranscriptionConfig,
	TranscriptionResult,
	TranscriptionWord,
} from "@/lib/transcription/config";

const MAX_REQUEST_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const ERROR_BODY_LIMIT = 500;

const LANGUAGE_NAME_CODES: Record<string, string> = {
	english: "en",
	spanish: "es",
	castilian: "es",
	french: "fr",
	german: "de",
	portuguese: "pt",
	italian: "it",
	dutch: "nl",
	flemish: "nl",
	polish: "pl",
	romanian: "ro",
	moldavian: "ro",
	moldovan: "ro",
	slovak: "sk",
	russian: "ru",
	turkish: "tr",
	japanese: "ja",
	korean: "ko",
	chinese: "zh",
	mandarin: "zh",
	arabic: "ar",
	hindi: "hi",
	bengali: "bn",
	tamil: "ta",
	telugu: "te",
	marathi: "mr",
	gujarati: "gu",
	punjabi: "pa",
	panjabi: "pa",
	urdu: "ur",
	persian: "fa",
	hebrew: "he",
};

interface TimedText {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenize(text: string): string[] {
	return text.split(/\s+/).filter((token) => token.length > 0);
}

function truncate(text: string): string {
	return text.length > ERROR_BODY_LIMIT
		? `${text.slice(0, ERROR_BODY_LIMIT)}…`
		: text;
}

export function toWhisperLanguage(
	language: AiGenerationLanguage | undefined,
): string | null {
	if (!language || language === AI_GENERATION_LANGUAGE_AUTO) return null;
	return language.split("-")[0]?.toLowerCase() || null;
}

export function normalizeLanguageCode(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	if (Object.hasOwn(LANGUAGE_NAME_CODES, lower)) {
		return LANGUAGE_NAME_CODES[lower] ?? trimmed;
	}
	if (/^[a-z]{2,3}(?:[-_][a-z0-9]+)*$/.test(lower)) return lower;
	return trimmed;
}

function parseTimedEntries(
	value: unknown,
	textKey: "word" | "text",
): TimedText[] {
	if (!Array.isArray(value)) return [];

	const entries: TimedText[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const rawText = entry[textKey];
		const start = finiteNumber(entry.start);
		const end = finiteNumber(entry.end);
		if (typeof rawText !== "string" || start === null || end === null) {
			continue;
		}
		const confidence = finiteNumber(entry.probability ?? entry.confidence);
		entries.push({
			text: rawText.trim(),
			start: Math.min(start, end),
			end: Math.max(start, end),
			confidence,
		});
	}

	return entries.sort(
		(left, right) => left.start - right.start || left.end - right.end,
	);
}

function restoreSegmentText(
	words: TimedText[],
	segments: TimedText[],
): TimedText[] {
	const restored = words.map((word) => ({ ...word }));
	const wordIndexesBySegment = segments.map((): number[] => []);

	let segmentIndex = 0;
	for (const [wordIndex, word] of words.entries()) {
		const midpoint = (word.start + word.end) / 2;
		while (
			segmentIndex < segments.length &&
			(segments[segmentIndex]?.end ?? Number.POSITIVE_INFINITY) < midpoint
		) {
			segmentIndex++;
		}
		const segment = segments[segmentIndex];
		if (segment && midpoint >= segment.start) {
			wordIndexesBySegment[segmentIndex]?.push(wordIndex);
		}
	}

	for (const [index, segment] of segments.entries()) {
		const tokens = tokenize(segment.text);
		const wordIndexes = wordIndexesBySegment[index] ?? [];
		if (tokens.length === 0 || tokens.length !== wordIndexes.length) continue;

		for (const [position, wordIndex] of wordIndexes.entries()) {
			const word = restored[wordIndex];
			const token = tokens[position];
			if (word && token) word.text = token;
		}
	}

	return restored;
}

function synthesizeWordsFromSegments(segments: TimedText[]): TimedText[] {
	const words: TimedText[] = [];

	for (const segment of segments) {
		const tokens = tokenize(segment.text);
		if (tokens.length === 0) continue;

		const step = (segment.end - segment.start) / tokens.length;
		for (const [index, token] of tokens.entries()) {
			words.push({
				text: token,
				start: segment.start + step * index,
				end: segment.start + step * (index + 1),
				confidence: null,
			});
		}
	}

	return words;
}

function toTranscriptionWord(word: TimedText): TranscriptionWord {
	const start = Math.round(word.start * 1000);
	return {
		text: word.text,
		start,
		end: Math.max(Math.round(word.end * 1000), start + 1),
		confidence: word.confidence,
	};
}

export function mapOpenAICompatibleResponse(
	response: unknown,
	model: string,
): TranscriptionResult | null {
	const body = isRecord(response) ? response : {};
	const segments = parseTimedEntries(body.segments, "text");
	const rawWords = parseTimedEntries(body.words, "word").filter(
		(word) => word.text.length > 0,
	);

	const text =
		typeof body.text === "string"
			? body.text
			: [...segments, ...rawWords].map((entry) => entry.text).join(" ");
	if (!text.trim()) return null;

	const words =
		rawWords.length > 0
			? restoreSegmentText(rawWords, segments)
			: synthesizeWordsFromSegments(segments);
	if (words.length === 0) {
		throw new Error(
			`Transcription response from model ${model} has text but no word or segment timestamps; use a model that supports response_format=verbose_json with timestamp_granularities`,
		);
	}

	const lastTimestamp = [...segments, ...words].reduce(
		(latest, entry) => Math.max(latest, entry.end),
		0,
	);

	return {
		words: words.map(toTranscriptionWord),
		language_code: normalizeLanguageCode(body.language),
		speech_model_used: model,
		audio_duration: finiteNumber(body.duration) ?? lastTimestamp,
	};
}

function describeEndpoint(endpoint: string): string {
	try {
		const url = new URL(endpoint);
		return `${url.origin}${url.pathname}`;
	} catch {
		return endpoint;
	}
}

function backoffDelayMs(attempt: number): number {
	return (
		BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
	);
}

function parseRetryAfterMs(response: Response): number | null {
	const retryAfterMs = response.headers.get("retry-after-ms")?.trim();
	if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs)) {
		return Math.ceil(Number(retryAfterMs));
	}

	const retryAfter = response.headers.get("retry-after")?.trim();
	if (!retryAfter) return null;
	const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter)
		? Number(retryAfter)
		: (Date.parse(retryAfter) - Date.now()) / 1000;
	return Number.isFinite(seconds)
		? Math.max(0, Math.ceil(seconds * 1000))
		: null;
}

function fetchErrorCode(error: unknown): string | null {
	const cause = error instanceof Error ? error.cause : undefined;
	return isRecord(cause) && typeof cause.code === "string" ? cause.code : null;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestOpenAICompatibleTranscription({
	config,
	audio,
	filename,
	contentType,
	language,
}: {
	config: OpenAICompatibleTranscriptionConfig;
	audio: Buffer;
	filename: string;
	contentType: string;
	language: string | null;
}): Promise<unknown> {
	const endpoint = `${config.baseUrl}/audio/transcriptions`;
	const target = `model=${config.model}, endpoint=${describeEndpoint(endpoint)}`;

	for (let attempt = 1; ; attempt++) {
		const form = new FormData();
		form.append(
			"file",
			new Blob([new Uint8Array(audio)], { type: contentType }),
			filename,
		);
		form.append("model", config.model);
		form.append("response_format", "verbose_json");
		form.append("timestamp_granularities[]", "word");
		form.append("timestamp_granularities[]", "segment");
		if (language) form.append("language", language);

		let response: Response;
		try {
			response = await fetch(endpoint, {
				method: "POST",
				headers: config.apiKey
					? { Authorization: `Bearer ${config.apiKey}` }
					: undefined,
				body: form,
			});
		} catch (error) {
			const code = fetchErrorCode(error);
			const reason = `${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ""}`;
			// A timed-out request is usually still running on the server, so
			// resubmitting it only stacks duplicate work on a slow Whisper host.
			const timedOut =
				code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
			if (timedOut || attempt >= MAX_REQUEST_ATTEMPTS) {
				throw new Error(
					`Transcription request failed after ${attempt} attempt(s) (${target}): ${reason}`,
					{ cause: error },
				);
			}
			const delayMs = backoffDelayMs(attempt);
			console.warn(
				`[transcribe] Transcription request error (${target}): ${reason}; retrying in ${delayMs}ms`,
			);
			await sleep(delayMs);
			continue;
		}

		if (response.ok) {
			const raw = await response.text();
			try {
				return JSON.parse(raw);
			} catch {
				throw new Error(
					`Transcription response was not valid JSON (${target}): ${truncate(raw)}`,
				);
			}
		}

		const errorBody = await response.text().catch(() => "");
		const retryable = response.status === 429 || response.status >= 500;
		const retryAfterMs = parseRetryAfterMs(response);
		const delayMs = retryAfterMs ?? backoffDelayMs(attempt);
		const failure = `Transcription request failed with ${response.status} ${response.statusText} (${target}): ${truncate(errorBody)}`;

		if (
			!retryable ||
			attempt >= MAX_REQUEST_ATTEMPTS ||
			delayMs > MAX_RETRY_DELAY_MS
		) {
			throw new Error(failure);
		}

		console.warn(`[transcribe] ${failure}; retrying in ${delayMs}ms`);
		await sleep(delayMs);
	}
}

export async function transcribeWithOpenAICompatible(
	config: OpenAICompatibleTranscriptionConfig,
	input: {
		audio: Buffer;
		contentType?: string;
		language?: AiGenerationLanguage;
	},
): Promise<TranscriptionResult | null> {
	const requestedLanguage = toWhisperLanguage(input.language);
	const chunks = await prepareTranscriptionAudio(
		input.audio,
		input.contentType,
	);

	const words: TranscriptionWord[] = [];
	let languageCode: string | null = null;
	let audioDurationSeconds = 0;
	let hasSpeech = false;

	for (const chunk of chunks) {
		// Pin later chunks to the language detected in the first one so a chunk
		// that opens with silence or music isn't re-detected as another language.
		const detectedLanguage =
			languageCode && /^[a-z]{2}$/.test(languageCode) ? languageCode : null;
		const response = await requestOpenAICompatibleTranscription({
			config,
			audio: chunk.audio,
			filename: chunk.filename,
			contentType: chunk.contentType,
			language: requestedLanguage ?? detectedLanguage,
		});

		const result = mapOpenAICompatibleResponse(response, config.model);
		if (!result) continue;

		hasSpeech = true;
		languageCode = languageCode ?? result.language_code;
		for (const word of result.words) {
			words.push({
				...word,
				start: word.start + chunk.offsetMs,
				end: word.end + chunk.offsetMs,
			});
		}
		if (result.audio_duration !== null) {
			audioDurationSeconds = Math.max(
				audioDurationSeconds,
				chunk.offsetMs / 1000 + result.audio_duration,
			);
		}
	}

	console.log(
		`[transcribe] OpenAI-compatible transcription finished: model=${config.model}, chunks=${chunks.length}, words=${words.length}, language=${languageCode ?? "unknown"}`,
	);

	if (!hasSpeech) return null;

	return {
		words,
		language_code: languageCode,
		speech_model_used: config.model,
		audio_duration: audioDurationSeconds > 0 ? audioDurationSeconds : null,
	};
}
