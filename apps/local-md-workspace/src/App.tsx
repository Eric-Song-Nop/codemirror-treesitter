import { Component, lazy, Suspense, type ElementType, type ReactNode } from "react";
import { LocalWorkspaceApp } from "@/components/workspace/LocalWorkspaceApp";
import { WorkspaceAgentCredentialsProvider } from "@/features/workspace-agent/WorkspaceAgentCredentialsProvider";
import { isSharedFilePath } from "@/lib/collaboration/shared-file-route";
import { I18nProvider, useI18n } from "@/lib/i18n";

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
    return <SharedFileRoute />;
  }

  return (
    <WorkspaceAgentCredentialsProvider>
      <LocalWorkspaceApp />
    </WorkspaceAgentCredentialsProvider>
  );
}

export function SharedFileRoute({ editor: Editor = SharedFileEditor }: { editor?: ElementType }) {
  return (
    <SharedFileRouteErrorBoundary>
      <Suspense fallback={<SharedFileRouteLoading />}>
        <Editor />
      </Suspense>
    </SharedFileRouteErrorBoundary>
  );
}

function SharedFileRouteLoading() {
  let { t } = useI18n();
  return (
    <main
      aria-busy="true"
      className="grid h-svh min-h-0 place-items-center bg-background p-6 text-foreground"
    >
      <div className="text-sm text-muted-foreground" role="status">
        {t("shared.loading")}
      </div>
    </main>
  );
}

class SharedFileRouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <SharedFileRouteFailure />;
  }
}

function SharedFileRouteFailure() {
  let { t } = useI18n();
  return (
    <main className="grid h-svh min-h-0 place-items-center bg-background p-6 text-foreground">
      <div className="grid max-w-md gap-4 text-center" role="alert">
        <div>
          <h1 className="text-base font-medium">{t("errors.couldNotLoadSharedEditor")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("shared.loadRetryHint")}</p>
        </div>
        <button
          className="mx-auto rounded-md border px-3 py-2 text-sm font-medium"
          type="button"
          onClick={() => window.location.reload()}
        >
          {t("actions.retry")}
        </button>
      </div>
    </main>
  );
}
