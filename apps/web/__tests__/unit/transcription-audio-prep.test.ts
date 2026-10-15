import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	spawnCalls: [] as string[][],
	transcodedBytes: 1_000,
	chunkBytes: 1_000,
}));
const ffmpegPathMock = vi.hoisted(() => vi.fn(() => "/fake/ffmpeg"));

vi.mock("@/lib/audio-extract", () => ({
	getFfmpegPath: ffmpegPathMock,
}));

vi.mock("node:child_process", async () => {
	const { EventEmitter } = await import("node:events");
	const { promises: fs } = await import("node:fs");

	return {
		spawn: (_command: string, args: string[]) => {
			state.spawnCalls.push(args);
			const proc = Object.assign(new EventEmitter(), {
				stderr: new EventEmitter(),
			});
			const outputPath = args[args.length - 1] ?? "";
			const size = args.includes("libmp3lame")
				? state.transcodedBytes
				: state.chunkBytes;
			fs.writeFile(outputPath, Buffer.alloc(size)).then(
				() => proc.emit("close", 0),
				(error: Error) => proc.emit("error", error),
			);
			return proc;
		},
	};
});

import {
	detectAudioContentType,
	MAX_TRANSCRIPTION_UPLOAD_BYTES,
	prepareTranscriptionAudio,
	TRANSCRIPTION_CHUNK_SECONDS,
} from "@/lib/transcription/audio-prep";

function argValue(args: string[], flag: string) {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

const mp4Header = Buffer.concat([
	Buffer.from([0, 0, 0, 24]),
	Buffer.from("ftypisom"),
	Buffer.alloc(16),
]);

describe("detectAudioContentType", () => {
	it("recognises MP4 and defaults to MP3", () => {
		expect(detectAudioContentType(mp4Header)).toBe("audio/mp4");
		expect(detectAudioContentType(Buffer.from("ID3\u0004rest"))).toBe(
			"audio/mpeg",
		);
	});
});

describe("prepareTranscriptionAudio", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		state.spawnCalls = [];
		state.transcodedBytes = 1_000;
		state.chunkBytes = 1_000;
		ffmpegPathMock.mockImplementation(() => "/fake/ffmpeg");
	});

	it("transcodes to 16 kHz mono 32 kbps MP3 in a single upload when small", async () => {
		const chunks = await prepareTranscriptionAudio(mp4Header, "audio/mp4");

		expect(state.spawnCalls).toHaveLength(1);
		const args = state.spawnCalls[0] ?? [];
		expect(argValue(args, "-ac")).toBe("1");
		expect(argValue(args, "-ar")).toBe("16000");
		expect(argValue(args, "-b:a")).toBe("32k");
		expect(argValue(args, "-i")).toMatch(/input\.mp4$/);

		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({
			offsetMs: 0,
			filename: "audio.mp3",
			contentType: "audio/mpeg",
		});
		expect(chunks[0]?.audio.length).toBe(1_000);
		expect(existsSync(dirname(argValue(args, "-i") ?? "/"))).toBe(false);
	});

	it("splits oversized audio into consecutive chunks with time offsets", async () => {
		state.transcodedBytes = 30_000_000;

		const chunks = await prepareTranscriptionAudio(Buffer.from("audio"));

		const estimatedSeconds = (state.transcodedBytes * 8) / 32_000;
		const expectedChunks = Math.ceil(
			estimatedSeconds / TRANSCRIPTION_CHUNK_SECONDS,
		);
		expect(state.transcodedBytes).toBeGreaterThan(
			MAX_TRANSCRIPTION_UPLOAD_BYTES,
		);
		expect(chunks).toHaveLength(expectedChunks);
		expect(chunks.map((chunk) => chunk.offsetMs)).toEqual(
			Array.from(
				{ length: expectedChunks },
				(_, index) => index * TRANSCRIPTION_CHUNK_SECONDS * 1000,
			),
		);

		const splitCalls = state.spawnCalls.slice(1);
		expect(splitCalls.map((args) => argValue(args, "-ss"))).toEqual(
			Array.from(
				{ length: expectedChunks },
				(_, index) => `${index * TRANSCRIPTION_CHUNK_SECONDS}`,
			),
		);
		expect(splitCalls.slice(0, -1).map((args) => argValue(args, "-t"))).toEqual(
			Array.from(
				{ length: expectedChunks - 1 },
				() => `${TRANSCRIPTION_CHUNK_SECONDS}`,
			),
		);
		expect(splitCalls.at(-1)).not.toContain("-t");
		expect(splitCalls.every((args) => argValue(args, "-c") === "copy")).toBe(
			true,
		);
		const workDir = dirname(argValue(state.spawnCalls[0] ?? [], "-i") ?? "/");
		expect(existsSync(workDir)).toBe(false);
	});

	it("sends small audio untouched when ffmpeg is unavailable", async () => {
		ffmpegPathMock.mockImplementation(() => {
			throw new Error("FFmpeg binary not found");
		});

		const chunks = await prepareTranscriptionAudio(mp4Header);

		expect(state.spawnCalls).toHaveLength(0);
		expect(chunks).toEqual([
			{
				audio: mp4Header,
				offsetMs: 0,
				filename: "audio.mp4",
				contentType: "audio/mp4",
			},
		]);
	});

	it("fails when ffmpeg is unavailable and the audio is too large to send", async () => {
		ffmpegPathMock.mockImplementation(() => {
			throw new Error("FFmpeg binary not found");
		});

		await expect(
			prepareTranscriptionAudio(
				Buffer.alloc(MAX_TRANSCRIPTION_UPLOAD_BYTES + 1),
			),
		).rejects.toThrow("FFmpeg binary not found");
	});
});
