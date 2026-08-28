/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { React } from "@webpack/common";

import { tryDecryptMessage } from "./messageDecrypt";
import { getSessionGeneration, subscribeToSession } from "./session";

const ReferencedMessageState = { LOADED: 0, NOT_LOADED: 1, DELETED: 2 } as const;

/**
 * Replaces the native reply-quote preview snippet with the decrypted text.
 *
 * Rather than drawing our own chrome next to Discord's reply (which never
 * matched the native look), we write the decrypted text straight into the
 * element Discord already renders for the referenced-message preview
 * (`repliedTextContent`). That keeps everything else — the chevron, the
 * "replied to @Name", the separators, hover, ellipsis truncation and
 * click-to-jump — exactly as Discord draws it, so an encrypted reply reads
 * like an ordinary one.
 *
 * The injected component itself renders a hidden anchor span so it survives as
 * a DOM node for look-up; the actual text lives in Discord's preview element.
 */
export function PGPReplyPreview(props: any) {
  const referenced = props?.referencedMessage;
  const target = referenced?.state === ReferencedMessageState.LOADED
    ? referenced.message
    : null;

  const armored = !!target?.content?.includes("-----BEGIN PGP MESSAGE-----");

  const generation = React.useSyncExternalStore(
    subscribeToSession,
    getSessionGeneration,
  );

  const [state, setState] = React.useState<{
    status: "idle" | "loading" | "success" | "error";
    plaintext?: string;
    error?: string;
  }>({ status: "idle" });

  const anchorRef = React.useRef<HTMLSpanElement>(null);

  React.useEffect(() => {
    if (!armored || !target) return;

    let stale = false;
    setState({ status: "loading" });

    tryDecryptMessage(target.content as string, target.author?.id ?? "").then(result => {
      if (stale || !result) return;
      if (result.success) {
        setState({ status: "success", plaintext: result.plaintext });
      } else {
        setState({ status: "error", error: result.error });
      }
    }).catch(err => {
      if (stale) return;
      setState({
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return () => {
      stale = true;
    };
  }, [armored, target?.id ?? "", target?.content ?? "", generation]);

  // Write the decrypted text into Discord's native preview slot. Ran on every
  // render (no deps) so that if Discord re-renders the quote and resets the
  // snippet to the raw ciphertext, we re-apply immediately.
  React.useLayoutEffect(() => {
    if (!armored || !anchorRef.current) return;

    const quote = anchorRef.current.closest<HTMLElement>(
      "[class*='messageReference']",
    ) ?? anchorRef.current.parentElement;

    const preview = quote?.querySelector<HTMLElement>(
      "[class*='repliedTextContent']",
    ) ?? quote?.querySelector<HTMLElement>(
      "[class*='repliedTextPreview']",
    );

    if (!preview) return;

    let text: string;
    if (state.status === "loading") {
      text = "Decrypting…";
    } else if (state.status === "error") {
      text = state.error ?? "Unable to decrypt";
    } else if (state.status === "success") {
      text = state.plaintext ?? "";
    } else {
      text = "Unlock your key to read this message";
    }

    preview.textContent = text;
  });

  if (!armored || !target) return null;

  return <span ref={anchorRef} style={{ display: "none" }} />;
}
