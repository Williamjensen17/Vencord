import { React } from "@webpack/common";

/**
 * Tags the message row so CSS can hide what Discord renders natively (the raw
 * ciphertext body, the opaque .pgp attachment card) while our accessory draws
 * the decrypted version.
 *
 * This used to be a patch on "Message must not be a thread starter message".
 * Discord changed that code — stock MessageLogger breaks on the same string —
 * so the class silently stopped being applied. An accessory already knows its
 * own DOM position, so it can tag its row itself and depend on nothing minified.
 */
export function useTagMessageRow<T extends HTMLElement>(className: string) {
  const ref = React.useRef<T>(null);

  React.useEffect(() => {
    const row = ref.current?.closest("li");
    if (!row) return;

    row.classList.add(className);
    return () => row.classList.remove(className);
  }, [className]);

  return ref;
}
