import ErrorBoundary from "@components/ErrorBoundary";
import { Parser, React } from "@webpack/common";
import { tryDecryptMessage } from "./messageDecrypt";
import { PgpEmbeds } from "./PgpEmbeds";
import { getSessionGeneration, subscribeToSession } from "./session";
import { settings } from "./settings";

// currentColor keeps these monochrome and following the theme, the way Discord's
// own inline markers do.
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

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2.5a1.5 1.5 0 0 1 1.3.75l9 15.5A1.5 1.5 0 0 1 21 21H3a1.5 1.5 0 0 1-1.3-2.25l9-15.5A1.5 1.5 0 0 1 12 2.5Zm-1 6v6h2v-6h-2Zm0 8v2h2v-2h-2Z"
      />
    </svg>
  );
}

export function PgpDecryptedAccessory({
  content,
  senderId,
}) {
  const [state, setState] = React.useState({
    status: "loading",
  } as any);

  const generation = React.useSyncExternalStore(
    subscribeToSession,
    getSessionGeneration,
  );

  // Must stay above the early returns — it is a hook.
  const { linkEmbeds: embedMode, lockIconColor, warningIconColor } = settings.use([
    "linkEmbeds",
    "lockIconColor",
    "warningIconColor",
  ]);

  React.useEffect(() => {
    // Guards against a slow decrypt from a previous generation landing after a
    // newer one and overwriting it.
    let stale = false;

    tryDecryptMessage(content, senderId).then(result => {
      if (stale || !result) return;

      if (result.success) {
        setState({
          status: "success",
          plaintext: result.plaintext,
          verified: result.verified,
        });
      } else {
        setState({
          status: "error",
          error: result.error,
        });
      }
    });

    return () => {
      stale = true;
    };
  }, [content, senderId, generation]);

  if (state.status === "loading") {
    return (
      <div className="vc-pgp-decrypted vc-pgp-notice">
        <LockIcon /> Decrypting…
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

  // A signature that is present but does not verify is the one case worth being
  // loud about — it means the message was tampered with, or is not from who it
  // claims. null just means unsigned.
  const tampered = state.verified === false;
  const badgeColor = tampered ? warningIconColor : lockIconColor;

  return (
    <div className="vc-pgp-decrypted">
      {/* Run it through Discord's own markdown parser, or the plaintext lands as
          a bare text node and links, mentions and emoji stay dead. */}
      {Parser.parse(state.plaintext)}
      <span
        className={
          "vc-pgp-badge"
          + (tampered ? " vc-pgp-badge--warn" : "")
          + (badgeColor ? " vc-pgp-badge--custom" : "")
        }
        style={badgeColor ? { color: badgeColor } : undefined}
        title={
          tampered
            ? "Decrypted — SIGNATURE INVALID. This message may have been tampered with."
            : state.verified === true
              ? "Decrypted — signature verified"
              : "Decrypted — not signed"
        }
      >
        {tampered ? <WarningIcon /> : <LockIcon />}
      </span>
      {/* An embed is a nicety. The decrypted text is the point — never let the
          former's failure blank the latter. */}
      {embedMode !== "off" && (
        <ErrorBoundary noop>
          <PgpEmbeds text={state.plaintext} autoLoad={embedMode === "auto"} />
        </ErrorBoundary>
      )}
    </div>
  );
}
