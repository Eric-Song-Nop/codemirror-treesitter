export function redactWorkspaceAgentErrorMessage(error: unknown, secret: string) {
  let message = error instanceof Error ? error.message : "The Agent request failed.";
  return secret ? message.split(secret).join("[redacted]") : message;
}

export function redactWorkspaceAgentError(error: unknown, secret: string): Error {
  let redacted = new Error(redactWorkspaceAgentErrorMessage(error, secret));
  redacted.name =
    error instanceof Error && error.name == "AbortError"
      ? "AbortError"
      : "WorkspaceAgentRuntimeError";
  return redacted;
}
