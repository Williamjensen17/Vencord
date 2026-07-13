import { PluginNative } from "@utils/types";
import { ContextMenuApi, FluxDispatcher, Menu, React } from "@webpack/common";

import { openPgpLightbox } from "./lightbox";

import { decryptFile, parsePublicKey } from "./crypto";
import { getKey, getOwnKeypair } from "./keystore";
import { getSessionGeneration, getUnlockedPrivateKey, isUnlocked, subscribeToSession } from "./session";
import { useTagMessageRow } from "./useTagMessageRow";

const Native = VencordNative.pluginHelpers?.PGP as
  | PluginNative<typeof import("./native")>
  | undefined;

export interface PgpAttachment {
  id: string;
  url: string;
  filename: string;
  size: number;
}

type State =
  | { status: "loading"; }
  | { status: "error"; error: string; }
  | {
    status: "ready";
    src: string;
    /** Kept for the clipboard — you cannot copy an image from a URL alone. */
    blob: Blob;
    filename: string;
    kind: "image" | "video" | "audio" | "file";
    verified: boolean | null;
    size: number;
  };

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const VIDEO = /\.(mp4|webm|mov|mkv)$/i;
const AUDIO = /\.(mp3|ogg|opus|wav|flac|m4a)$/i;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav",
  flac: "audio/flac", m4a: "audio/mp4",
};

function classify(filename: string): "image" | "video" | "audio" | "file" {
  if (IMAGE.test(filename)) return "image";
  if (VIDEO.test(filename)) return "video";
  if (AUDIO.test(filename)) return "audio";
  return "file";
}

function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchCiphertext(url: string): Promise<Uint8Array> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CDN returned ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    // Discord's CDN does not allow cross-origin reads: the request succeeds and
    // the browser then refuses to hand it over (ERR_FAILED with status 200). Go
    // through the main process, where there is no CORS.
    if (!Native?.fetchAttachment) {
      throw new Error(
        "Cannot read attachment (CORS), and the native helper is missing. " +
        "Fully restart Vesktop — a reload does not update the main process.",
      );
    }

    const b64 = await Native.fetchAttachment(url);
    if (!b64) throw err;
    return base64ToBytes(b64);
  }
}

function save(src: string, filename: string) {
  const a = document.createElement("a");
  a.href = src;
  a.download = filename;
  a.click();
}

/** Chromium's clipboard only accepts PNG for images, so anything else is re-encoded. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("could not decode image"));
      el.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        b => b ? resolve(b) : reject(new Error("could not encode PNG")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function copyImage(blob: Blob) {
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": await toPng(blob) }),
  ]);
}

function MediaMenu({
  src,
  blob,
  filename,
  kind,
}: {
  src: string;
  blob: Blob;
  filename: string;
  kind: "image" | "video" | "audio" | "file";
}) {
  return (
    <Menu.Menu
      navId="vc-pgp-media"
      onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
      aria-label="Encrypted attachment"
    >
      {kind === "image" && (
        <Menu.MenuItem
          id="vc-pgp-copy-image"
          label="Copy Image"
          action={() => copyImage(blob)}
        />
      )}
      <Menu.MenuItem
        id="vc-pgp-save"
        label={`Save ${kind === "image" ? "Image" : kind === "video" ? "Video" : "File"}`}
        action={() => save(src, filename)}
      />
      <Menu.MenuItem
        id="vc-pgp-copy-name"
        label="Copy File Name"
        action={() => navigator.clipboard.writeText(filename)}
      />
    </Menu.Menu>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a5 5 0 0 0-5 5v2H6.5A1.5 1.5 0 0 0 5 10.5v9A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 17.5 9H17V7a5 5 0 0 0-5-5Zm3 7H9V7a3 3 0 1 1 6 0v2Z"
      />
    </svg>
  );
}

function One({ attachment, senderId }: { attachment: PgpAttachment; senderId: string; }) {
  const [state, setState] = React.useState<State>({ status: "loading" });
  const generation = React.useSyncExternalStore(subscribeToSession, getSessionGeneration);

  React.useEffect(() => {
    if (!isUnlocked()) {
      setState({ status: "error", error: "Private key locked." });
      return;
    }

    let stale = false;
    let objectUrl: string | undefined;

    (async () => {
      try {
        const ciphertext = await fetchCiphertext(attachment.url);

        const verifyKeys = [] as Awaited<ReturnType<typeof parsePublicKey>>[];
        const senderEntry = await getKey(senderId);
        if (senderEntry?.publicKeyArmored) {
          verifyKeys.push(await parsePublicKey(senderEntry.publicKeyArmored));
        }
        const own = await getOwnKeypair();
        if (own?.publicKeyArmored) {
          verifyKeys.push(await parsePublicKey(own.publicKeyArmored));
        }

        const result = await decryptFile(
          ciphertext,
          getUnlockedPrivateKey(),
          verifyKeys.filter(Boolean) as any,
        );

        if (stale) return;

        const filename = result.filename || "attachment";
        const blob = new Blob([result.bytes as BlobPart], { type: mimeFor(filename) });
        objectUrl = URL.createObjectURL(blob);

        setState({
          status: "ready",
          src: objectUrl,
          blob,
          filename,
          kind: classify(filename),
          verified: result.verified,
          size: result.bytes.length,
        });
      } catch (err) {
        if (!stale) {
          setState({
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      stale = true;
      // A 50MB video leaked on every remount adds up fast.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.url, senderId, generation]);

  if (state.status === "loading") {
    return (
      <div className="vc-pgp-decrypted vc-pgp-notice">
        <LockIcon /> Decrypting attachment…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="vc-pgp-decrypted vc-pgp-notice">
        <LockIcon /> {state.error}
      </div>
    );
  }

  const title = state.verified === false
    ? "Decrypted — SIGNATURE INVALID. This file may have been tampered with."
    : state.verified === true
      ? "Decrypted — signature verified"
      : "Decrypted — not signed";

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ContextMenuApi.openContextMenu(e, () => (
      <MediaMenu
        src={state.src}
        blob={state.blob}
        filename={state.filename}
        kind={state.kind}
      />
    ));
  };

  if (state.kind === "image") {
    return (
      <div className="vc-pgp-attachment" title={title}>
        <img
          className="vc-pgp-attachment-media vc-pgp-attachment-image"
          src={state.src}
          alt={state.filename}
          onContextMenu={onContextMenu}
          onClick={() => openPgpLightbox(state.src, state.filename)}
        />
      </div>
    );
  }

  if (state.kind === "video") {
    return (
      <div className="vc-pgp-attachment" title={title}>
        <video
          className="vc-pgp-attachment-media"
          src={state.src}
          controls
          onContextMenu={onContextMenu}
        />
      </div>
    );
  }

  if (state.kind === "audio") {
    return (
      <div className="vc-pgp-attachment" title={title}>
        <audio src={state.src} controls onContextMenu={onContextMenu} />
      </div>
    );
  }

  return (
    <a
      className="vc-pgp-attachment-file"
      href={state.src}
      download={state.filename}
      title={title}
      onContextMenu={onContextMenu}
    >
      <LockIcon />
      <span className="vc-pgp-attachment-name">{state.filename}</span>
      <span className="vc-pgp-attachment-size">{formatSize(state.size)}</span>
    </a>
  );
}

export function PgpAttachments({
  attachments,
  senderId,
}: {
  attachments: PgpAttachment[];
  senderId: string;
}) {
  const ref = useTagMessageRow<HTMLDivElement>("vc-pgp-has-encrypted-file");

  if (!attachments.length) return null;

  return (
    <div className="vc-pgp-attachments" ref={ref}>
      {attachments.map(a => <One key={a.id} attachment={a} senderId={senderId} />)}
    </div>
  );
}
