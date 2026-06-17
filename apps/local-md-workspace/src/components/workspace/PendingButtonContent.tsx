import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";

type PendingButtonContentProps = {
  children: ReactNode;
  pending: boolean;
  pendingLabel?: ReactNode;
};

export function PendingButtonContent({
  children,
  pending,
  pendingLabel = children,
}: PendingButtonContentProps) {
  if (!pending) return children;

  return (
    <>
      <Spinner aria-hidden data-icon="inline-start" />
      <span className="truncate">{pendingLabel}</span>
    </>
  );
}
