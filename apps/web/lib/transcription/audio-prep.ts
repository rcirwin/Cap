import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "@/lib/audio-extract";

export const MAX_TRANSCRIPTION_UPLOAD_BYTES = 24_000_000;
export const TRANSCRIPTION_CHUNK_SECONDS = 20 * 60;

const TRANSCODE_BITRATE_KBPS = 32;
const TRANSCODE_SAMPLE_RATE = 16_000;
const FFMPEG_STDERR_LIMIT = 4_000;

export interface TranscriptionAudioChunk {
	audio: Buffer;
	offsetMs: number;
	filename: string;
	contentType: string;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
	"audio/mpeg": "mp3",
	"audio/mp3": "mp3",
	"audio/mp4": "mp4",
	"audio/m4a": "m4a",
	"audio/x-m4a": "m4a",
	"video/mp4": "mp4",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/webm": "webm",
	"video/webm": "webm",
	"audio/flac": "flac",
};

export function detectAudioContentType(audio: Buffer): string {
	if (audio.length >= 8 && audio.toString("latin1", 4, 8) === "ftyp") {
		return "audio/mp4";
	}
	const magic = audio.toString("latin1", 0, 4);
	if (magic === "RIFF") return "audio/wav";
	if (magic === "OggS") return "audio/ogg";
	if (magic === "fLaC") return "audio/flac";
	if (audio.length >= 4 && audio.readUInt32BE(0) === 0x1a45dfa3) {
		return "audio/webm";
	}
	return "audio/mpeg";
}

export function getAudioFileExtension(contentType: string): string {
	const baseType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return CONTENT_TYPE_EXTENSIONS[baseType] ?? "mp3";
}

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(/*turbopackIgnore: true*/ ffmpeg, args, {
			stdio: ["ignore", "ignore", "pipe"],
		});

		let stderr = "";
		proc.stderr?.on("data", (data: Buffer) => {
			stderr = `${stderr}${data.toString()}`.slice(-FFMPEG_STDERR_LIMIT);
		});

		proc.on("error", (error: Error) => {
			reject(
				new Error(`Transcription audio preparation failed: ${error.message}`),
			);
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(
					`Transcription audio preparation failed with code ${code}: ${stderr}`,
				),
			);
		});
	});
}

export async function prepareTranscriptionAudio(
	audio: Buffer,
	contentType?: string,
): Promise<TranscriptionAudioChunk[]> {
	const inputContentType = contentType ?? detectAudioContentType(audio);
	const inputExtension = getAudioFileExtension(inputContentType);

	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch (error) {
		if (audio.length > MAX_TRANSCRIPTION_UPLOAD_BYTES) throw error;
		console.warn(
			"[transcribe] ffmpeg is unavailable; sending audio to the transcription endpoint without transcoding",
			error,
		);
		return [
			{
				audio,
				offsetMs: 0,
				filename: `audio.${inputExtension}`,
				contentType: inputContentType,
			},
		];
	}

	const workDir = await fs.mkdtemp(join(tmpdir(), "transcription-"));
	try {
		const inputPath = join(workDir, `input.${inputExtension}`);
		const transcodedPath = join(workDir, "transcoded.mp3");
		await fs.writeFile(inputPath, audio);

		await runFfmpeg(ffmpeg, [
			"-hide_banner",
			"-nostdin",
			"-loglevel",
			"error",
			"-i",
			inputPath,
			"-vn",
			"-map_metadata",
			"-1",
			"-ac",
			"1",
			"-ar",
			`${TRANSCODE_SAMPLE_RATE}`,
			"-c:a",
			"libmp3lame",
			"-b:a",
			`${TRANSCODE_BITRATE_KBPS}k`,
			"-f",
			"mp3",
			"-y",
			transcodedPath,
		]);
		await fs.unlink(inputPath).catch(() => {});

		const transcoded = await fs.readFile(transcodedPath);
		if (transcoded.length <= MAX_TRANSCRIPTION_UPLOAD_BYTES) {
			return [
				{
					audio: transcoded,
					offsetMs: 0,
					filename: "audio.mp3",
					contentType: "audio/mpeg",
				},
			];
		}

		const estimatedSeconds =
			(transcoded.length * 8) / (TRANSCODE_BITRATE_KBPS * 1000);
		const chunkCount = Math.ceil(
			estimatedSeconds / TRANSCRIPTION_CHUNK_SECONDS,
		);
		console.log(
			`[transcribe] Splitting ${transcoded.length} bytes (~${Math.round(estimatedSeconds)}s) of audio into ${chunkCount} transcription chunks`,
		);

		const chunks: TranscriptionAudioChunk[] = [];
		for (let index = 0; index < chunkCount; index++) {
			const offsetSeconds = index * TRANSCRIPTION_CHUNK_SECONDS;
			const isLastChunk = index === chunkCount - 1;
			const chunkPath = join(workDir, `chunk-${index}.mp3`);

			// The last chunk runs to the end of the file so a bitrate-based
			// duration estimate that is slightly short can never drop audio.
			await runFfmpeg(ffmpeg, [
				"-hide_banner",
				"-nostdin",
				"-loglevel",
				"error",
				"-ss",
				`${offsetSeconds}`,
				...(isLastChunk ? [] : ["-t", `${TRANSCRIPTION_CHUNK_SECONDS}`]),
				"-i",
				transcodedPath,
				"-c",
				"copy",
				"-f",
				"mp3",
				"-y",
				chunkPath,
			]);

			const chunk = await fs.readFile(chunkPath);
			await fs.unlink(chunkPath).catch(() => {});
			if (chunk.length === 0) continue;

			chunks.push({
				audio: chunk,
				offsetMs: offsetSeconds * 1000,
				filename: `audio-${index}.mp3`,
				contentType: "audio/mpeg",
			});
		}

		return chunks;
	} finally {
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}
