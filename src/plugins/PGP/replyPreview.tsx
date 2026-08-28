/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Parser, React } from "@webpack/common";

import { tryDecryptMessage } from "./messageDecrypt";
import { getSessionGeneration, subscribeToSession } from "./session";

const ReferencedMessageState = { LOADED: 0, NOT_LOADED: 1, DELETED: 2 } as const;

function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a5 5 0 0 0-5 5v2H6.5A1.5 1.5 0 0 0 5 10.5v9A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 17.5 9H17V7a5 5 0 0 0-5-5Zm3 7H9V7a3 3 0 1 1 6 0v2Z"
      />
    </svg>
  );
}

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

  React.useEffect(() => {
    if (!armored || !selfRef.current) return;

    const quote = selfRef.current.closest<HTMLElement>(
      "[class*='messageReference']",
    ) ?? selfRef.current.parentElement;

    quote?.classList.add("vc-pgp-reply-decrypted");
    return () => quote?.classList.remove("vc-pgp-reply-decrypted");
  }, [armored, state.status]);

  if (!armored || !target) return null;

  let label: React.ReactNode;
  if (state.status === "loading") {
    label = <span className="vc-pgp-reply-text">Decrypting…</span>;
  } else if (state.status === "error") {
    label = <span className="vc-pgp-reply-text">{state.error}</span>;
  } else if (state.status === "success") {
    label = <span className="vc-pgp-reply-text">
      {Parser.parse(state.plaintext ?? "")}
    </span>;
  } else {
    label = <span className="vc-pgp-reply-text">Unlock your key to read</span>;
  }

  return (
    <span className="vc-pgp-reply" ref={selfRef}>
      <span className="vc-pgp-reply-badge" aria-hidden="true"><LockGlyph /></span>
      {label}
    </span>
  );
}
