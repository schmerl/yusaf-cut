import type { SourceMedia, Word } from "@/lib/edl";

// v1 could contain edited project text; never reuse it as raw recognition.
const TRANSCRIPT_CACHE_PREFIX = "yusafcut.recognition.v2.";

function transcriptCacheKey(media: SourceMedia): string {
  return `${TRANSCRIPT_CACHE_PREFIX}${media.sha256}`;
}

export function readTranscriptCache(media: SourceMedia): Word[] | null {
  try {
    const raw = localStorage.getItem(transcriptCacheKey(media));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { words?: Word[]; mediaSha256?: string };
    return parsed.mediaSha256 === media.sha256 && Array.isArray(parsed.words) ? parsed.words : null;
  } catch {
    return null;
  }
}

export function writeTranscriptCache(media: SourceMedia, words: Word[]) {
  try {
    localStorage.setItem(
      transcriptCacheKey(media),
      JSON.stringify({ mediaSha256: media.sha256, updatedAt: new Date().toISOString(), words }),
    );
  } catch {
    // Cache failure should never block editing.
  }
}

export function clearTranscriptCache(media: SourceMedia) {
  try {
    localStorage.removeItem(transcriptCacheKey(media));
  } catch {
    // Cache failure should never block editing.
  }
}
