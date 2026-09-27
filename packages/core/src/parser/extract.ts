/**
 * Text extraction for syllabus sources (items 18, 19).
 * - PDFs via unpdf (pure JS, no native deps) with page markers.
 * - Scanned PDFs produce too little text -> caller falls back to OCR
 *   (Tesseract.js) which runs only inside the edge function runtime.
 * - Pasted text passes through; URLs are fetched with SSRF protection.
 */

import { unzipSync, strFromU8 } from "fflate";

export const PAGE_MARKER = "--- PAGE ";

export type ExtractResult = {
  text: string;
  pageCount: number;
  needsOcr: boolean;
};

export function extractTextFromPdf(buf: Uint8Array): ExtractResult {
  // The concrete extractor is wired by the runtime (unpdf in the edge function).
  const raw = extractPdfTextImpl(buf);
  const pages = Array.isArray(raw) ? raw : [raw];
  const joined = pages.join("\n");
  const pageCount = countPageMarkers(joined) || pages.length;
  return {
    text: withPageMarkers(pages),
    pageCount,
    needsOcr: joined.replace(/\s+/g, "").length < 100 && pageCount > 0,
  };
}

function countPageMarkers(text: string): number {
  return (text.match(/--- PAGE \d+ ---/g) ?? []).length;
}

function withPageMarkers(pages: string[]): string {
  return pages.map((p, i) => `${PAGE_MARKER}${i + 1} ---\n${p}`).join("\n\n");
}

export function withPageMarkersPublic(pages: string[]): string {
  return withPageMarkers(pages);
}

/** Overridable in the edge runtime (which imports unpdf). */
let extractPdfTextImpl: (buf: Uint8Array) => string | string[] = (_buf) => {
  // Node fallback: try unpdf if installed; else throw so callers surface a clear error.
  throw new Error(
    "PDF text extraction requires the edge runtime implementation (unpdf) — see supabase/functions/_shared/extract.ts",
  );
};

export function setPdfExtractor(fn: (buf: Uint8Array) => string | string[]) {
  extractPdfTextImpl = fn;
}

/** Strip HTML to normalized text (item 19). */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** SSRF protection: block non-http(s), private, loopback, link-local hosts (item 19). */
export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const host = url.hostname.toLowerCase();
  const blockedHosts = ["localhost", "metadata.google.internal", "169.254.169.254"];
  if (blockedHosts.includes(host)) {
    throw new Error("Blocked host");
  }
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("Private IP ranges are not allowed");
  }
  if (/^127\./.test(host) || host === "::1" || /^0\./.test(host)) {
    throw new Error("Loopback addresses are not allowed");
  }
  if (
    /^169\.254\./.test(host) ||
    /^fe80:/i.test(host) ||
    /^fc00:/i.test(host) ||
    /^fd/i.test(host)
  ) {
    throw new Error("Link-local / private addresses are not allowed");
  }
  return url;
}

export async function fetchSyllabusText(rawUrl: string): Promise<string> {
  const url = assertSafeUrl(rawUrl);
  const res = await fetch(url, {
    redirect: "error",
    headers: { "user-agent": "StudylySyllabusBot/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Fetch failed with ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (ct.includes("text/html")) return stripHtml(body);
  return body.slice(0, 400_000);
}

/** Decompressed unzip helper used by the OCR path for nested containers. */
export function unzipText(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  return Object.keys(files)
    .filter((k) => k.endsWith(".txt"))
    .map((k) => strFromU8(files[k]!));
}
