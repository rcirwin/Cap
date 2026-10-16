import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";

const serverEnvMock = vi.hoisted(() =>
	vi.fn<() => Record<string, string | undefined>>(() => ({})),
);
const prepareAudioMock = vi.hoisted(() => vi.fn());
const assemblyTranscribeMock = vi.hoisted(() => vi.fn());

vi.mock("@cap/env", () => ({
	serverEnv: serverEnvMock,
}));

vi.mock("@/lib/transcription/audio-prep", () => ({
	prepareTranscriptionAudio: prepareAudioMock,
}));

vi.mock("assemblyai", () => ({
	AssemblyAI: class {
		transcripts = { transcribe: assemblyTranscribeMock };
	},
}));

import {
	GROQ_TRANSCRIPTION_BASE_URL,
	getTranscriptionConfig,
	getTranscriptionProvider,
	isTranscriptionConfigured,
	NoSpokenAudioError,
} from "@/lib/transcription/config";
import {
	mapOpenAICompatibleResponse,
	normalizeLanguageCode,
} from "@/lib/transcription/openai-compatible";
import { transcribeAudioBuffer } from "@/lib/transcription/provider";

type FetchMock = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

const envWith = (env: Record<string, string | undefined>) => {
	serverEnvMock.mockReturnValue(env);
};

const verboseResponse = {
	task: "transcribe",
	language: "English",
	duration: 3.5,
	text: " Hello, world. This is Cap.",
	segments: [
		{ id: 0, start: 0, end: 1.5, text: " Hello, world." },
		{ id: 1, start: 1.6, end: 3.5, text: " This is Cap." },
	],
	words: [
		{ word: "Hello", start: 0.1, end: 0.6 },
		{ word: "world", start: 0.7, end: 1.4 },
		{ word: "This", start: 1.7, end: 2.0 },
		{ word: "is", start: 2.1, end: 2.3 },
		{ word: "Cap", start: 2.5, end: 3.4 },
	],
};

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function requestForm(fetchMock: Mock<FetchMock>, call = 0) {
	const body = fetchMock.mock.calls[call]?.[1]?.body;
	if (!(body instanceof FormData)) {
		throw new Error("Expected a multipart transcription request");
	}
	return body;
}

describe("transcription provider resolution", () => {
	it("is not configured without any transcription credentials", () => {
		envWith({ OPENAI_API_KEY: "openai-key" });

		expect(getTranscriptionConfig()).toBeNull();
		expect(getTranscriptionProvider()).toBeNull();
		expect(isTranscriptionConfigured()).toBe(false);
	});

	it("uses AssemblyAI when ASSEMBLY_API_KEY is set, even alongside Groq", () => {
		envWith({ ASSEMBLY_API_KEY: "assembly-key", GROQ_API_KEY: "groq-key" });

		expect(getTranscriptionConfig()).toEqual({
			provider: "assemblyai",
			apiKey: "assembly-key",
		});
		expect(isTranscriptionConfigured()).toBe(true);
	});

	it("falls back to Groq Whisper when only GROQ_API_KEY is set", () => {
		envWith({ GROQ_API_KEY: "groq-key" });

		expect(getTranscriptionConfig()).toEqual({
			provider: "openai-compatible",
			baseUrl: GROQ_TRANSCRIPTION_BASE_URL,
			apiKey: "groq-key",
			model: "whisper-large-v3-turbo",
		});
	});

	it("treats empty strings as unset", () => {
		envWith({ ASSEMBLY_API_KEY: "", GROQ_API_KEY: "groq-key" });

		expect(getTranscriptionProvider()).toBe("openai-compatible");
	});

	it("lets an explicit TRANSCRIPTION_PROVIDER override auto-detection", () => {
		envWith({
			TRANSCRIPTION_PROVIDER: "openai-compatible",
			ASSEMBLY_API_KEY: "assembly-key",
			GROQ_API_KEY: "groq-key",
		});

		expect(getTranscriptionProvider()).toBe("openai-compatible");
	});

	it("does not fall back when the explicit provider is missing its credentials", () => {
		envWith({ TRANSCRIPTION_PROVIDER: "assemblyai", GROQ_API_KEY: "groq-key" });
		expect(getTranscriptionConfig()).toBeNull();

		envWith({ TRANSCRIPTION_PROVIDER: "openai-compatible" });
		expect(getTranscriptionConfig()).toBeNull();
	});

	it("supports a keyless local server via TRANSCRIPTION_BASE_URL", () => {
		envWith({
			TRANSCRIPTION_BASE_URL: "http://speaches:8000/v1/",
			TRANSCRIPTION_MODEL: "Systran/faster-whisper-large-v3",
		});

		expect(getTranscriptionConfig()).toEqual({
			provider: "openai-compatible",
			baseUrl: "http://speaches:8000/v1",
			apiKey: null,
			model: "Systran/faster-whisper-large-v3",
		});
	});

	it("never sends GROQ_API_KEY to a non-Groq base URL", () => {
		envWith({
			TRANSCRIPTION_BASE_URL: "https://api.openai.com/v1",
			GROQ_API_KEY: "groq-key",
		});
		expect(getTranscriptionConfig()).toMatchObject({ apiKey: null });

		envWith({
			TRANSCRIPTION_BASE_URL: "https://api.openai.com/v1",
			TRANSCRIPTION_API_KEY: "openai-key",
			TRANSCRIPTION_MODEL: "whisper-1",
			GROQ_API_KEY: "groq-key",
		});
		expect(getTranscriptionConfig()).toEqual({
			provider: "openai-compatible",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "openai-key",
			model: "whisper-1",
		});
	});

	it("uses TRANSCRIPTION_API_KEY against Groq when no base URL is set", () => {
		envWith({ TRANSCRIPTION_API_KEY: "transcription-key" });

		expect(getTranscriptionConfig()).toMatchObject({
			provider: "openai-compatible",
			baseUrl: GROQ_TRANSCRIPTION_BASE_URL,
			apiKey: "transcription-key",
		});
	});
});

describe("mapOpenAICompatibleResponse", () => {
	it("converts seconds to milliseconds and restores segment punctuation", () => {
		const result = mapOpenAICompatibleResponse(
			verboseResponse,
			"whisper-large-v3-turbo",
		);

		expect(result).toEqual({
			words: [
				{ text: "Hello,", start: 100, end: 600, confidence: null },
				{ text: "world.", start: 700, end: 1400, confidence: null },
				{ text: "This", start: 1700, end: 2000, confidence: null },
				{ text: "is", start: 2100, end: 2300, confidence: null },
				{ text: "Cap.", start: 2500, end: 3400, confidence: null },
			],
			language_code: "en",
			speech_model_used: "whisper-large-v3-turbo",
			audio_duration: 3.5,
		});
	});

	it("keeps raw words for a segment whose token count does not match", () => {
		const result = mapOpenAICompatibleResponse(
			{
				...verboseResponse,
				segments: [
					{ start: 0, end: 1.5, text: " Hello - world." },
					{ start: 1.6, end: 3.5, text: " This is Cap." },
				],
			},
			"whisper-1",
		);

		expect(result?.words.map((word) => word.text)).toEqual([
			"Hello",
			"world",
			"This",
			"is",
			"Cap.",
		]);
	});

	it("synthesizes evenly spaced words when only segments are returned", () => {
		const result = mapOpenAICompatibleResponse(
			{
				text: "One two three four",
				language: "en",
				segments: [{ start: 1, end: 3, text: " One two three four" }],
			},
			"whisper-1",
		);

		expect(result?.words).toEqual([
			{ text: "One", start: 1000, end: 1500, confidence: null },
			{ text: "two", start: 1500, end: 2000, confidence: null },
			{ text: "three", start: 2000, end: 2500, confidence: null },
			{ text: "four", start: 2500, end: 3000, confidence: null },
		]);
		expect(result?.audio_duration).toBe(3);
	});

	it("keeps zero-length words playable and maps word probabilities", () => {
		const result = mapOpenAICompatibleResponse(
			{
				text: "a",
				words: [{ word: " a", start: 1, end: 1, probability: 0.75 }],
			},
			"whisper-1",
		);

		expect(result?.words).toEqual([
			{ text: "a", start: 1000, end: 1001, confidence: 0.75 },
		]);
	});

	it("returns null for empty or whitespace-only text", () => {
		expect(
			mapOpenAICompatibleResponse(
				{ text: "  ", segments: [], words: [] },
				"whisper-1",
			),
		).toBeNull();
		expect(mapOpenAICompatibleResponse({ text: "" }, "whisper-1")).toBeNull();
	});

	it("rejects text responses without any timestamps", () => {
		expect(() =>
			mapOpenAICompatibleResponse({ text: "Hello there" }, "gpt-4o-transcribe"),
		).toThrow(/no word or segment timestamps/);
	});

	it("normalizes language names to ISO-639-1 codes", () => {
		expect(normalizeLanguageCode("english")).toBe("en");
		expect(normalizeLanguageCode("Spanish")).toBe("es");
		expect(normalizeLanguageCode("EN")).toBe("en");
		expect(normalizeLanguageCode("Swahili")).toBe("Swahili");
		expect(normalizeLanguageCode("constructor")).toBe("constructor");
		expect(normalizeLanguageCode(undefined)).toBeNull();
	});
});

describe("transcribeAudioBuffer", () => {
	const fetchMock = vi.fn<FetchMock>();

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		prepareAudioMock.mockImplementation(async (audio: Buffer) => [
			{ audio, offsetMs: 0, filename: "audio.mp3", contentType: "audio/mpeg" },
		]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("posts a verbose_json multipart request to Groq and maps the result", async () => {
		envWith({ GROQ_API_KEY: "groq-key" });
		fetchMock.mockResolvedValueOnce(jsonResponse(verboseResponse));

		const result = await transcribeAudioBuffer(Buffer.from("audio"), {
			language: "es",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(`${GROQ_TRANSCRIPTION_BASE_URL}/audio/transcriptions`);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({ Authorization: "Bearer groq-key" });

		const form = requestForm(fetchMock);
		expect(form.get("model")).toBe("whisper-large-v3-turbo");
		expect(form.get("response_format")).toBe("verbose_json");
		expect(form.getAll("timestamp_granularities[]")).toEqual([
			"word",
			"segment",
		]);
		expect(form.get("language")).toBe("es");
		expect(form.get("file")).toBeInstanceOf(Blob);

		expect(result.words[0]).toEqual({
			text: "Hello,",
			start: 100,
			end: 600,
			confidence: null,
		});
		expect(result.language_code).toBe("en");
		expect(result.speech_model_used).toBe("whisper-large-v3-turbo");
	});

	it("omits the language for auto-detect and the auth header for keyless servers", async () => {
		envWith({ TRANSCRIPTION_BASE_URL: "http://localhost:8000/v1" });
		fetchMock.mockResolvedValueOnce(jsonResponse(verboseResponse));

		await transcribeAudioBuffer(Buffer.from("audio"), { language: "auto" });

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("http://localhost:8000/v1/audio/transcriptions");
		expect(init?.headers).toBeUndefined();
		expect(requestForm(fetchMock).get("language")).toBeNull();
	});

	it("reports empty text as no spoken audio", async () => {
		envWith({ GROQ_API_KEY: "groq-key" });
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ text: " ", segments: [], words: [], duration: 4 }),
		);

		const error = await transcribeAudioBuffer(Buffer.from("audio")).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(NoSpokenAudioError);
		expect((error as Error).message.toLowerCase()).toContain("no spoken audio");
	});

	it("retries rate-limited requests, honouring retry-after", async () => {
		envWith({ GROQ_API_KEY: "groq-key" });
		fetchMock
			.mockResolvedValueOnce(
				new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "0" },
				}),
			)
			.mockResolvedValueOnce(jsonResponse(verboseResponse));

		const result = await transcribeAudioBuffer(Buffer.from("audio"));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.words).toHaveLength(5);
	});

	it("fails fast on client errors with the status and a truncated body", async () => {
		envWith({ GROQ_API_KEY: "groq-key" });
		fetchMock.mockResolvedValueOnce(
			new Response(`invalid file ${"x".repeat(2_000)}`, {
				status: 400,
				statusText: "Bad Request",
			}),
		);

		const error = await transcribeAudioBuffer(Buffer.from("audio")).catch(
			(caught: unknown) => caught,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NoSpokenAudioError);
		const message = (error as Error).message;
		expect(message).toContain("400 Bad Request");
		expect(message).toContain("invalid file");
		expect(message.length).toBeLessThan(1_000);
	});

	it("does not resubmit a request that timed out waiting for the server", async () => {
		envWith({ TRANSCRIPTION_BASE_URL: "http://localhost:8000/v1" });
		fetchMock.mockRejectedValueOnce(
			new TypeError("fetch failed", {
				cause: Object.assign(new Error("Headers Timeout Error"), {
					code: "UND_ERR_HEADERS_TIMEOUT",
				}),
			}),
		);

		await expect(transcribeAudioBuffer(Buffer.from("audio"))).rejects.toThrow(
			/UND_ERR_HEADERS_TIMEOUT/,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("offsets chunk timestamps and pins later chunks to the detected language", async () => {
		envWith({ GROQ_API_KEY: "groq-key" });
		prepareAudioMock.mockResolvedValueOnce([
			{
				audio: Buffer.from("a"),
				offsetMs: 0,
				filename: "audio-0.mp3",
				contentType: "audio/mpeg",
			},
			{
				audio: Buffer.from("b"),
				offsetMs: 1_200_000,
				filename: "audio-1.mp3",
				contentType: "audio/mpeg",
			},
		]);
		fetchMock
			.mockResolvedValueOnce(jsonResponse(verboseResponse))
			.mockResolvedValueOnce(
				jsonResponse({
					language: "english",
					duration: 2,
					text: " Goodbye.",
					segments: [{ start: 0, end: 2, text: " Goodbye." }],
					words: [{ word: "Goodbye", start: 0.5, end: 1.5 }],
				}),
			);

		const result = await transcribeAudioBuffer(Buffer.from("audio"));

		expect(requestForm(fetchMock, 0).get("language")).toBeNull();
		expect(requestForm(fetchMock, 1).get("language")).toBe("en");
		expect(result.words.at(-1)).toEqual({
			text: "Goodbye.",
			start: 1_200_500,
			end: 1_201_500,
			confidence: null,
		});
		expect(result.audio_duration).toBe(1_202);
	});

	it("routes AssemblyAI no-speech errors into NoSpokenAudioError", async () => {
		envWith({ ASSEMBLY_API_KEY: "assembly-key" });
		assemblyTranscribeMock.mockResolvedValueOnce({
			id: "silent",
			status: "error",
			error:
				"language_detection cannot be performed on files with no spoken audio.",
		});

		await expect(
			transcribeAudioBuffer(Buffer.from("audio")),
		).rejects.toBeInstanceOf(NoSpokenAudioError);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(prepareAudioMock).not.toHaveBeenCalled();
	});

	it("passes AssemblyAI words through unchanged", async () => {
		envWith({ ASSEMBLY_API_KEY: "assembly-key" });
		const words = [
			{ text: "Hi.", start: 10, end: 200, confidence: 0.9, speaker: "A" },
		];
		assemblyTranscribeMock.mockResolvedValueOnce({
			id: "ok",
			status: "completed",
			words,
			language_code: "en",
			speech_model_used: "universal-3-5-pro",
			audio_duration: 1,
		});

		const result = await transcribeAudioBuffer(Buffer.from("audio"), {
			language: "en",
		});

		expect(assemblyTranscribeMock.mock.calls[0]?.[0]).toMatchObject({
			language_code: "en",
			disfluencies: true,
		});
		expect(result).toEqual({
			words,
			language_code: "en",
			speech_model_used: "universal-3-5-pro",
			audio_duration: 1,
		});
	});
});
