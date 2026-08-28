/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Parser, React } from "@webpack/common";

import { tryDecryptMessage } from "./messageDecrypt";
import { getSessionGeneration, subscribeToSession } from "./session";

const ReferencedMessageState = { LOADED: 0, NOT_LOADED: 1, DELETED: 2 } as const;

/**
 * Decrypted reply-quote preview.
 *
 * Discord's reply quote renders the referenced message's first line into a
 * React-controlled element (`repliedTextContent`). Writing into that element
 * directly does not survive: React owns it and reverts the text on the next
 * commit, so the decrypted text vanishes.
 *
 * Instead we render our own span right next to Discord's preview (the injected
 * component is a sibling in the quote's children array) and, for encrypted
 * replies, hide Discord's original ciphertext preview. Our span is a normal
 * React child, so it stays rendered and scrolls/truncates like Discord's own
 * snippet.
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

  const selfRef = React.useRef<HTMLSpanElement>(null);

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

  // Tag the reply quote so CSS can hide Discord's own ciphertext preview.
  React.useLayoutEffect(() => {
    if (!armored || !selfRef.current) return;

    const quote = selfRef.current.closest<HTMLElement>(
      "[class*='messageReference']",
    ) ?? selfRef.current.parentElement;

    quote?.classList.add("vc-pgp-reply");
    return () => quote?.classList.remove("vc-pgp-reply");
  }, [armored]);

  // The patch injects this component immediately after the clickable spine,
  // before the avatar and name. Move it to the end of the quote so it occupies
  // Discord's native preview position. This runs before every paint because
  // React may restore the node to its original child-array position.
  React.useLayoutEffect(() => {
    if (!armored) return;

    const el = selfRef.current;
    const parent = el?.parentElement;
    if (!el || !parent || parent.lastElementChild === el) return;

    parent.appendChild(el);
  });

  if (!armored || !target) return null;

  const text: React.ReactNode =
    state.status === "loading"
      ? "Decrypting…"
      : state.status === "error"
        ? (state.error ?? "Unable to decrypt")
        : state.status === "success"
          ? Parser.parse(state.plaintext ?? "")
          : "Unlock your key to read this message";

  const onClick = props?.onClickReply;

  return (
    <span
      ref={selfRef}
      className="vc-pgp-reply-text"
      onClick={onClick}
      role={onClick ? "button" : undefined}
    >
      {text}
    </span>
  );
}
