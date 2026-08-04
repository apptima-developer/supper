import type {
  ServiceNowWriteAttemptSummary,
  ServiceNowWriteCommandSummary,
} from "./types";

export type ServiceNowRecoveryAvailability = {
  attempt?: ServiceNowWriteAttemptSummary;
  recoverableAt?: string;
  remainingMilliseconds: number;
  canRequestRecovery: boolean;
};

export function serviceNowRecoveryAvailability(
  command: ServiceNowWriteCommandSummary,
  nowMilliseconds = Date.now(),
): ServiceNowRecoveryAvailability {
  const attempt = command.attempts?.find((item) => item.outcome === "executing");
  const recoverableAtMilliseconds = attempt
    ? new Date(attempt.recoverableAt).getTime()
    : Number.NaN;
  const remainingMilliseconds = Number.isFinite(recoverableAtMilliseconds)
    ? Math.max(0, recoverableAtMilliseconds - nowMilliseconds)
    : 0;
  return {
    attempt,
    recoverableAt: attempt?.recoverableAt,
    remainingMilliseconds,
    canRequestRecovery: command.status === "executing"
      && Boolean(attempt)
      && Number.isFinite(recoverableAtMilliseconds)
      && remainingMilliseconds === 0,
  };
}
