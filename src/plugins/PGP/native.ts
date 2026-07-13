import { IpcMainInvokeEvent } from "electron";
import { lookup } from "dns/promises";
import { isIP } from "net";

/**
 * Discord scrapes OpenGraph tags server-side to build embeds. Our messages are
 * ciphertext, so its servers see no link and never do that. This does the same
 * scrape from the main process, where there is no CORS to fight.
 */

export interface LinkMetadata {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  /** Inlined as a data: URI — Discord's img-src will not load an arbitrary host. */
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  /** The site's own theme-color, used for the embed's left bar like Discord does. */
  color?: string;
}

// What Discord's own scraper sends. Plenty of sites (GitHub included) only serve
// OpenGraph tags to something that looks like a crawler.
const USER_AGENT = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

// Only ever needs to cover <head>. YouTube's full page is ~1.5MB, so reading to
// the end and capping there just meant no embed at all; we stop at </head>.
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;

/**
 * The URL here comes from whoever sent the message, and we are fetching it from
 * inside the user's network. Without this, a crafted link (http://192.168.1.1/…)
 * turns every reader into a port scanner for the sender.
 */
function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    // loopback, link-local, unique-local
    return v6 === "::1" || v6.startsWith("fe80") || v6.startsWith("fc") || v6.startsWith("fd");
  }

  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;

  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||            // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||  // CGNAT
    a >= 224                               // multicast / reserved
  );
}

async function assertPublic(url: URL) {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("unsupported protocol");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("private address");
    return;
  }

  const { address } = await lookup(host);
  if (isPrivateAddress(address)) throw new Error("private address");
}

/** fetch, but validating every hop rather than trusting redirect following. */
async function safeFetch(rawUrl: string, accept: string): Promise<Response> {
  let url = new URL(rawUrl);

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublic(url);

    const res = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, accept },
    });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }

    return res;
  }

  throw new Error("too many redirects");
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length"));
  if (len && len > max) throw new Error("too large");

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error("too large");
  return buf;
}

/**
 * Reads only as far as </head>, then hangs up. Every meta tag we care about lives
 * there, and some pages (YouTube: ~1.5MB) are enormous past it.
 */
async function readHead(res: Response, max: number): Promise<string> {
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";

  try {
    while (html.length < max) {
      const { done, value } = await reader.read();
      if (done) break;

      html += decoder.decode(value, { stream: true });

      const end = html.indexOf("</head>");
      if (end !== -1) return html.slice(0, end);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return html;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", "#x27": "'", nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    const key = e.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return m;
  });
}

function parseMetaTags(html: string): Record<string, string> {
  const tags: Record<string, string> = {};

  for (const [tag] of html.matchAll(/<meta\s[^>]*>/gi)) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const value = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && value) tags[key.toLowerCase()] = decodeEntities(value);
  }

  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  if (title) tags.__title = decodeEntities(title.trim());

  return tags;
}

async function fetchImageAsDataUri(src: string): Promise<string | undefined> {
  try {
    const res = await safeFetch(src, "image/*");
    const type = res.headers.get("content-type")?.split(";")[0]?.trim();

    if (!res.ok || !type?.startsWith("image/")) return undefined;

    const buf = await readCapped(res, MAX_IMAGE_BYTES);
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

const ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

/**
 * CORS fallback for pulling encrypted attachments off Discord's CDN. Restricted
 * to Discord's own hosts so this cannot be used as a general-purpose fetcher by
 * anything that gets a URL into it.
 *
 * Returns base64 — IPC cannot carry a Uint8Array.
 */
export async function fetchAttachment(
  _: IpcMainInvokeEvent,
  rawUrl: string,
): Promise<string | null> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !ATTACHMENT_HOSTS.has(url.hostname)) return null;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { "user-agent": USER_AGENT },
    });
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString("base64");
  } catch {
    return null;
  }
}

export async function fetchLinkMetadata(
  _: IpcMainInvokeEvent,
  rawUrl: string,
): Promise<LinkMetadata | null> {
  try {
    const res = await safeFetch(rawUrl, "text/html,application/xhtml+xml");
    if (!res.ok) return null;

    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("html")) return null;

    const html = await readHead(res, MAX_HTML_BYTES);
    const tags = parseMetaTags(html);

    const title = tags["og:title"] ?? tags["twitter:title"] ?? tags.__title;
    const description = tags["og:description"] ?? tags["twitter:description"] ?? tags.description;
    const imageSrc = tags["og:image"] ?? tags["og:image:url"] ?? tags["twitter:image"];

    if (!title && !description && !imageSrc) return null;

    const image = imageSrc
      ? await fetchImageAsDataUri(new URL(imageSrc, rawUrl).href)
      : undefined;

    // Only ever a literal color — this string ends up in a style attribute.
    const rawColor = tags["theme-color"] ?? tags["msapplication-tilecolor"];
    const color = rawColor && /^#[0-9a-f]{3,8}$/i.test(rawColor.trim())
      ? rawColor.trim()
      : undefined;

    return {
      url: rawUrl,
      siteName: tags["og:site_name"] ?? new URL(rawUrl).hostname.replace(/^www\./, ""),
      title,
      description,
      image,
      imageWidth: Number(tags["og:image:width"]) || undefined,
      imageHeight: Number(tags["og:image:height"]) || undefined,
      color,
    };
  } catch {
    return null;
  }
}
