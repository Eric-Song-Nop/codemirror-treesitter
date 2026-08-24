import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceApplication } from "@/app/workspace-application";

const WorkspaceApplicationContext = createContext<WorkspaceApplication | null>(null);

export function WorkspaceApplicationProvider({
  application,
  children,
}: {
  application: WorkspaceApplication;
  children: ReactNode;
}) {
  return (
    <WorkspaceApplicationContext.Provider value={application}>
      {children}
    </WorkspaceApplicationContext.Provider>
  );
}

export function useWorkspaceApplication() {
  let application = useContext(WorkspaceApplicationContext);
  if (!application) {
    throw new Error("WorkspaceApplicationProvider is missing.");
  }
  return application;
}
