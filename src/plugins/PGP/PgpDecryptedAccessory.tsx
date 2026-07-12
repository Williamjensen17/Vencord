import { React } from "@webpack/common";
import { tryDecryptMessage } from "./messageDecrypt";

export function PgpDecryptedAccessory({
  content,
  senderId,
}) {
  const [state, setState] = React.useState({
    status: "loading",
  } as any);

  React.useEffect(() => {
    tryDecryptMessage(content, senderId).then(result => {
      if (!result) return;

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
  }, [content, senderId]);

  if (state.status === "loading") {
    return <div>🔒 Decrypting…</div>;
  }

  if (state.status === "error") {
    return <div>⚠️ {state.error}</div>;
  }

  return (
    <div>
      <div>
        🔓 Decrypted{" "}
        {state.verified === true ? "✅" : ""}
      </div>
      <div>{state.plaintext}</div>
    </div>
  );
}
