import { React } from "@webpack/common";
import { tryDecryptMessage } from "./messageDecrypt";

interface Props {
  content: string;
  senderId: string;
}

export function PgpDecryptedAccessory({ content, senderId }: Props) {
  const [state, setState] = React.useState<
    | { status: "loading" }
    | { status: "success"; plaintext: string; verified: boolean | null }
    | { status: "error"; error: string }
  >({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;

    tryDecryptMessage(content, senderId).then(result => {
      if (cancelled) return;
      if (!result) return; // shouldn't happen, we already checked the marker

      if (result.success) {
        setState({
          status: "success",
          plaintext: result.plaintext!,
          verified: result.verified,
        });
      } else {
        setState({ status: "error", error: result.error ?? "Unknown error" });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [content, senderId]);

  if (state.status === "loading") {
    return (
      <div style={{ opacity: 0.6, fontStyle: "italic" }}>
        🔒 Decrypting PGP message…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div style={{ color: "var(--status-danger)" }}>
        ⚠️ Failed to decrypt PGP message: {state.error}
      </div>
    );
  }

  const badge =
    state.verified === true
      ? "✅ verified"
      : state.verified === false
      ? "⚠️ signature invalid"
      : null;

  return (
    <div
      style={{
        border: "1px solid var(--background-modifier-accent)",
        borderRadius: 4,
        padding: "6px 10px",
        marginTop: 4,
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
        🔓 Decrypted{badge ? ` · ${badge}` : ""}
      </div>
      <div>{state.plaintext}</div>
    </div>
  );
}
