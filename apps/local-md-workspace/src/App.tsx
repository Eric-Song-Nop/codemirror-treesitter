import { lazy, Suspense } from "react";
import { LocalWorkspaceApp } from "@/components/workspace/LocalWorkspaceApp";
import { isSharedFilePath } from "@/lib/collaboration/shared-file-route";
import { I18nProvider } from "@/lib/i18n";

const SharedFileEditor = lazy(async () => {
  let module = await import("@/components/SharedFileEditor");
  return { default: module.SharedFileEditor };
});

export function App() {
  return (
    <I18nProvider>
      <AppRoutes />
    </I18nProvider>
  );
}

function AppRoutes() {
  if (isSharedFilePath(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <SharedFileEditor />
      </Suspense>
    );
  }

  return <LocalWorkspaceApp />;
}
