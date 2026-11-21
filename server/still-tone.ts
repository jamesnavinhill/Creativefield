import { execFile } from "node:child_process";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ffmpegPath, runTool } from "./audio-processing-validation";

const execute = promisify(execFile);

/** Share of pixels at or below this luma (0-255, full range) that counts as pure black. */
const BLACK_LUMA = 15;
/** H3-Image stills with at least this share of pure black are crushed: hair, cloth and faces in shade lose all detail. */
export const CRUSHED_BLACK_SHARE = 0.015;

/** Opens the toe only: shadow detail comes back, black stays dark, mid-tones and highlights are left as made.
 *  Runs in 16-bit RGB with no YUV round trip; the first version (8-bit eq through YUV plus a highlight shoulder)
 *  posterised skies, tinted them green and greyed the whites (, user report 2026-11-20). */
export const STILL_TONE_FILTER = "format=gbrp16le,curves=master='0/0.035 0.08/0.11 0.25/0.265 0.5/0.5 0.75/0.75 1/1',format=rgb24";

export type StillTone = { blackShare: number; whiteShare: number; applied: boolean };

/** Black and clipped-white shares, from a 512 px wide grey copy. */
export function lumaShares(gray: Uint8Array): { blackShare: number; whiteShare: number } {
  let black = 0, white = 0;
  for (const value of gray) { if (value <= BLACK_LUMA) black++; else if (value >= 241) white++; }
  const total = Math.max(1, gray.length);
  return { blackShare: black / total, whiteShare: white / total };
}

export const needsStillTone = ({ blackShare }: { blackShare: number }) => blackShare >= CRUSHED_BLACK_SHARE;

async function measure(source: string) {
  const { stdout } = await execute(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", source,
    "-vf", "scale=512:-2:out_range=pc,format=gray", "-frames:v", "1", "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024, timeout: 30000, windowsHide: true });
  return lumaShares(stdout);
}

const encoderFor = { "image/png": ["-c:v", "png"], "image/jpeg": ["-c:v", "mjpeg", "-q:v", "2"], "image/webp": ["-c:v", "libwebp", "-quality", "95"] } as const;

/** Writes a toned copy of a crushed still and hands it to `use`; a still that is not crushed is left alone (`use` is not called). */
export async function withTonedStill<T>(source: string, contentType: keyof typeof encoderFor, use: (file: string) => Promise<T>): Promise<{ tone: StillTone; result?: T }> {
  const shares = await measure(source);
  if (!needsStillTone(shares)) return { tone: { ...shares, applied: false } };
  const folder = await mkdtemp(join(dirname(source), ".still-tone-"));
  const output = join(folder, `toned.${contentType.split("/")[1].replace("jpeg", "jpg")}`);
  try {
    await runTool(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", source,
      "-vf", STILL_TONE_FILTER, "-frames:v", "1", ...encoderFor[contentType], "-map_metadata", "-1", output,
    ], undefined, 60000);
    return { tone: { ...shares, applied: true }, result: await use(output) };
  } finally {
    await unlink(output).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}
