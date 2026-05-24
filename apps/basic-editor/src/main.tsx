import "./style.css";
import { createRoot } from "react-dom/client";
import { TyporaEditor } from "./typora-editor";

createRoot(document.querySelector<HTMLDivElement>("#app")!).render(<TyporaEditor />);
