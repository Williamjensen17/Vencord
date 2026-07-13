import { React } from "@webpack/common";
import { tryDecryptMessage } from "./messageDecrypt";
import { getSessionGeneration, subscribeToSession } from "./session";

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
    return <div className="vc-pgp-decrypted">🔒 Decrypting…</div>;
  }

  if (state.status === "error") {
    return <div className="vc-pgp-decrypted">⚠️ {state.error}</div>;
  }

  return (
    <div className="vc-pgp-decrypted" style={{ marginTop: 4 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        🔓 Decrypted{" "}
        {state.verified === true ? "✅" : ""}
      </div>
      <div style={{ whiteSpace: "pre-wrap" }}>{state.plaintext}</div>
    </div>
  );
}
