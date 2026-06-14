import { SharedFileEditor, isSharedFilePath } from "@/components/SharedFileEditor";
import { LocalWorkspaceApp } from "@/components/workspace/LocalWorkspaceApp";
import { I18nProvider } from "@/lib/i18n";

export function App() {
  return (
    <I18nProvider>
      <AppRoutes />
    </I18nProvider>
  );
}

function AppRoutes() {
  if (isSharedFilePath(window.location.pathname)) {
    return <SharedFileEditor />;
  }

  return <LocalWorkspaceApp />;
}
