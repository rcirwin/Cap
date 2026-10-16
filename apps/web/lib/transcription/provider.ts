import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
} from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";
import { getAssemblyAITranscriptionOptions } from "@/lib/assemblyai";
import {
	type AssemblyAITranscriptionConfig,
	getTranscriptionConfig,
	NoSpokenAudioError,
	type TranscriptionResult,
} from "@/lib/transcription/config";
import { transcribeWithOpenAICompatible } from "@/lib/transcription/openai-compatible";

export async function transcribeAudioBuffer(
	audio: Buffer,
	options: { contentType?: string; language?: AiGenerationLanguage } = {},
): Promise<TranscriptionResult> {
	const config = getTranscriptionConfig();
	if (!config) {
		throw new Error("No transcription provider is configured");
	}

	const language = options.language ?? AI_GENERATION_LANGUAGE_AUTO;

	if (config.provider === "assemblyai") {
		return transcribeWithAssemblyAI(config, audio, language);
	}

	const result = await transcribeWithOpenAICompatible(config, {
		audio,
		contentType: options.contentType,
		language,
	});
	if (!result) {
		throw new NoSpokenAudioError(
			`OpenAI-compatible transcription (model=${config.model}, language=${language}) found no spoken audio`,
		);
	}
	return result;
}

async function transcribeWithAssemblyAI(
	config: AssemblyAITranscriptionConfig,
	audio: Buffer,
	language: AiGenerationLanguage,
): Promise<TranscriptionResult> {
	const client = new AssemblyAI({ apiKey: config.apiKey });

	const transcript = await client.transcripts.transcribe({
		audio,
		...getAssemblyAITranscriptionOptions(language),
		disfluencies: true,
	});

	console.log(
		`[transcribe] AssemblyAI transcript ${transcript.id} finished with status=${transcript.status}, model=${transcript.speech_model_used ?? "unknown"}`,
	);

	if (transcript.status === "error") {
		const transcriptError = transcript.error ?? "Unknown error";
		const message = `AssemblyAI transcription failed (id=${transcript.id}, language=${language}): ${transcriptError}`;

		if (transcriptError.toLowerCase().includes("no spoken audio")) {
			throw new NoSpokenAudioError(message);
		}

		throw new Error(message);
	}

	return {
		words: transcript.words ?? [],
		language_code:
			typeof transcript.language_code === "string"
				? transcript.language_code
				: null,
		speech_model_used:
			typeof transcript.speech_model_used === "string"
				? transcript.speech_model_used
				: null,
		audio_duration:
			typeof transcript.audio_duration === "number"
				? transcript.audio_duration
				: null,
	};
}
