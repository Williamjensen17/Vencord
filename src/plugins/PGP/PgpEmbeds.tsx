import { React } from "@webpack/common";
import { PluginNative } from "@utils/types";

import { openPgpLightbox } from "./lightbox";
import type { LinkMetadata } from "./native";

// Undefined when the main process predates this plugin's native.ts — i.e. Vesktop
// was only reloaded (Ctrl+R), not fully restarted. Never let that take the
// decrypted message down with it.
const Native = VencordNative.pluginHelpers?.PGP as
  | PluginNative<typeof import("./native")>
  | undefined;

// Deliberately NOT Discord's internal <Embed>. That component's title and media
// paths expect a real embed record instance with methods on it, not a plain
// object, and blow up with "r is not a function". Its shape is private and
// minified, so we build the card ourselves from Discord's CSS variables instead —
// looks native, and their internals cannot break it.

// Discord caps embeds per message; match it rather than unfurling everything.
const MAX_EMBEDS = 3;

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

const YOUTUBE_RE =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|live\/)([\w-]{11})|youtu\.be\/([\w-]{11}))/i;

const SPOTIFY_RE =
  /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})/i;

const SPOTIFY_HEIGHTS: Record<string, number> = {
  track: 152, episode: 152, album: 352, playlist: 352, artist: 352, show: 352,
};

interface Player {
  src: string;
  height: number;
  /** Render the player on its own, with no embed card around it. */
  bare: boolean;
}

/** The inline player Discord gives you for YouTube/Spotify, where one applies. */
function getPlayer(url: string): Player | null {
  const yt = YOUTUBE_RE.exec(url);
  if (yt) {
    return {
      // Must be www.youtube.com: Discord's CSP only frames the origins its own
      // embeds use, and Vencord has no frame-src allowlist to add another.
      src: `https://www.youtube.com/embed/${yt[1] ?? yt[2]}`,
      height: 225,
      // Discord gives YouTube a full card: title, description, thumbnail.
      bare: false,
    };
  }

  const sp = SPOTIFY_RE.exec(url);
  if (sp) {
    return {
      src: `https://open.spotify.com/embed/${sp[1]}/${sp[2]}`,
      height: SPOTIFY_HEIGHTS[sp[1].toLowerCase()] ?? 352,
      // Spotify's own player already is the embed. Discord wraps it in no card,
      // and neither should we.
      bare: true,
    };
  }

  return null;
}

function extractUrls(text: string): string[] {
  const seen = new Set<string>();

  for (const [match] of text.matchAll(URL_RE)) {
    // Trailing punctuation is almost never part of the link.
    const url = match.replace(/[.,;:!?)\]}]+$/, "");
    if (!seen.has(url)) seen.add(url);
    if (seen.size >= MAX_EMBEDS) break;
  }

  return [...seen];
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path fill="currentColor" d="M8 5.14v13.72a.5.5 0 0 0 .76.43l11.02-6.86a.5.5 0 0 0 0-.86L8.76 4.71A.5.5 0 0 0 8 5.14Z" />
    </svg>
  );
}

function LinkEmbed({ url, autoLoad }: { url: string; autoLoad: boolean; }) {
  const [meta, setMeta] = React.useState<LinkMetadata | null>(null);
  const [requested, setRequested] = React.useState(autoLoad);
  const [playing, setPlaying] = React.useState(false);

  const player = React.useMemo(() => getPlayer(url), [url]);

  const bare = player?.bare ?? false;

  React.useEffect(() => {
    // A bare player needs no metadata — it is the embed.
    if (!requested || bare || !Native) return;

    let stale = false;
    Native.fetchLinkMetadata(url)
      .then(m => { if (!stale) setMeta(m); })
      .catch(() => { /* a dead link must not blank the message */ });

    return () => { stale = true; };
  }, [url, requested, bare]);

  if (!requested) {
    return (
      <button className="vc-pgp-embed-chip" onClick={() => setRequested(true)}>
        <PlayIcon />
        <span>Load preview</span>
      </button>
    );
  }

  if (bare && player) {
    return (
      <iframe
        className="vc-pgp-embed-frame"
        src={player.src}
        height={player.height}
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
      />
    );
  }

  if (!meta) return null;

  // A direct link to a gif/image/video. Discord renders these bare and inline,
  // with no embed card around them, so we do the same.
  if (meta.mediaKind && meta.media) {
    if (meta.mediaKind === "video") {
      return (
        <video className="vc-pgp-embed-media" src={meta.media} controls loop />
      );
    }

    return (
      <img
        className="vc-pgp-embed-media vc-pgp-embed-media--image"
        src={meta.media}
        alt=""
        onClick={() => openPgpLightbox(meta.media!)}
      />
    );
  }

  return (
    <div
      className="vc-pgp-embed"
      style={meta.color ? { borderColor: meta.color } : undefined}
    >
      {meta.siteName && (
        <div className="vc-pgp-embed-provider">{meta.siteName}</div>
      )}

      {meta.title && (
        <a
          className="vc-pgp-embed-title"
          href={url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {meta.title}
        </a>
      )}

      {meta.description && (
        <div className="vc-pgp-embed-description">{meta.description}</div>
      )}

      {playing && player
        ? (
          <iframe
            className="vc-pgp-embed-frame"
            src={player.src}
            height={player.height}
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
          />
        )
        : (
          <>
            {meta.image && (
              player
                ? (
                  <button
                    className="vc-pgp-embed-thumb-button"
                    onClick={() => setPlaying(true)}
                    title="Play"
                  >
                    <img className="vc-pgp-embed-image" src={meta.image} alt="" />
                    <span className="vc-pgp-embed-play"><PlayIcon /></span>
                  </button>
                )
                : <img className="vc-pgp-embed-image" src={meta.image} alt="" />
            )}
            {player && !meta.image && (
              <button className="vc-pgp-embed-chip" onClick={() => setPlaying(true)}>
                <PlayIcon />
                <span>Play</span>
              </button>
            )}
          </>
        )}
    </div>
  );
}

export function PgpEmbeds({ text, autoLoad }: { text: string; autoLoad: boolean; }) {
  const urls = React.useMemo(() => extractUrls(text), [text]);
  if (!Native || !urls.length) return null;

  return (
    <div className="vc-pgp-embeds">
      {urls.map(url => <LinkEmbed key={url} url={url} autoLoad={autoLoad} />)}
    </div>
  );
}
