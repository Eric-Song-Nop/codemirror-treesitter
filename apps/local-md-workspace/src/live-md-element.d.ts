import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { LiveMdEditorElement } from "@codemirror-treesitter/live-md";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "live-md-editor": DetailedHTMLProps<
        HTMLAttributes<LiveMdEditorElement> & {
          placeholder?: string;
        },
        LiveMdEditorElement
      >;
    }
  }
}
