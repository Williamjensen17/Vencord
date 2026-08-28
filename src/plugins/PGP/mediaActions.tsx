/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ContextMenuApi, FluxDispatcher, Menu, React } from "@webpack/common";

export type MediaKind = "image" | "video" | "audio" | "file";

/**
 * fetch() resolves blob: and data: URLs, so every action here works from the src
 * alone — no Blob needs threading through. That matters because linked media is a
 * data: URI with no Blob behind it, while decrypted attachments are blob:.
 */
async function toBlob(src: string): Promise<Blob> {
  return await (await fetch(src)).blob();
}

export function saveMedia(src: string, filename: string) {
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

export async function copyImage(src: string) {
  const png = await toPng(await toBlob(src));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

function label(kind: MediaKind) {
  return kind === "image" ? "Image" : kind === "video" ? "Video" : kind === "audio" ? "Audio" : "File";
}

export function MediaMenu({
  src,
  filename,
  kind,
}: {
  src: string;
  filename: string;
  kind: MediaKind;
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
          action={() => copyImage(src)}
        />
      )}
      <Menu.MenuItem
        id="vc-pgp-save"
        label={`Save ${label(kind)}`}
        action={() => saveMedia(src, filename)}
      />
      <Menu.MenuItem
        id="vc-pgp-copy-name"
        // The real filename, not the opaque <hex>.pgp we upload under.
        label="Copy File Name"
        action={() => navigator.clipboard.writeText(filename)}
      />
    </Menu.Menu>
  );
}

export function openMediaMenu(
  e: React.MouseEvent,
  src: string,
  filename: string,
  kind: MediaKind,
) {
  e.preventDefault();
  e.stopPropagation();
  ContextMenuApi.openContextMenu(e, () => (
    <MediaMenu src={src} filename={filename} kind={kind} />
  ));
}
