/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { React } from "@webpack/common";

import { copyImage, openMediaMenu, saveMedia } from "./mediaActions";

// Vencord types ModalRoot as `never`, so it cannot be used in JSX as-is.
const Root = ModalRoot as unknown as React.ComponentType<any>;

/**
 * Deliberately NOT Discord's openImageModal.
 *
 * That modal is built for CDN attachments: it rewrites the url to add resizing
 * query params (?width=&height=). Hand it a blob: or data: URL and the rewrite
 * produces something unfetchable — the modal opens and displays nothing, which
 * is exactly what happened. Same lesson as its <Embed> component: those internals
 * only accept their own CDN-shaped inputs.
 *
 * Our media never touches the CDN in plaintext, so it will never be CDN-shaped.
 * A plain modal we control is both simpler and unbreakable by their changes.
 */

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"
      />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3v10.2l3.6-3.6L17 11l-5 5-5-5 1.4-1.4L12 13.2V3h.01ZM5 18h14v2H5v-2Z"
      />
    </svg>
  );
}

export function openPgpLightbox(src: string, filename = "image") {
  openModal(props => (
    <Root {...props} size={ModalSize.DYNAMIC} className="vc-pgp-lightbox">
      <div className="vc-pgp-lightbox-actions">
        <button
          className="vc-pgp-lightbox-action"
          aria-label="Copy image"
          title="Copy image"
          onClick={() => copyImage(src)}
        >
          <CopyIcon />
        </button>
        <button
          className="vc-pgp-lightbox-action"
          aria-label="Save image"
          title="Save image"
          onClick={() => saveMedia(src, filename)}
        >
          <SaveIcon />
        </button>
      </div>

      <img
        className="vc-pgp-lightbox-image"
        src={src}
        alt={filename}
        onContextMenu={e => openMediaMenu(e, src, filename, "image")}
        onClick={() => props.onClose()}
      />
    </Root>
  ));
}
