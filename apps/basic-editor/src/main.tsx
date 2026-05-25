import "@codemirror-treesitter/typora-runtime/style.css";
import "./style.css";
import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import { createInitialMarkdown, mountTyporaEditor } from "@codemirror-treesitter/typora-runtime";
import heroUrl from "./assets/hero.png";

function TyporaEditor() {
  let editorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let parent = editorRef.current;
    if (!parent) return;
    return mountTyporaEditor(parent, {
      initialDoc: createInitialMarkdown(heroUrl),
    });
  }, []);

  return (
    <main className="editor-shell" aria-label="Markdown editor demo">
      <div className="paper">
        <div ref={editorRef} className="editor-mount" />
      </div>
    </main>
  );
}

createRoot(document.querySelector<HTMLDivElement>("#app")!).render(<TyporaEditor />);
