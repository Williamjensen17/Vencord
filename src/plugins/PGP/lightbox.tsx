import { ModalRoot, ModalSize, openModal } from "@utils/modal";
import { React } from "@webpack/common";

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
export function openPgpLightbox(src: string, alt = "") {
  openModal(props => (
    <Root {...props} size={ModalSize.DYNAMIC} className="vc-pgp-lightbox">
      <img
        className="vc-pgp-lightbox-image"
        src={src}
        alt={alt}
        onClick={() => props.onClose()}
      />
    </Root>
  ));
}
