import type { IntakeSessionStatus } from "./contracts";
import { IntakeCoreError } from "./errors";

export const allowedSessionTransitions: Readonly<Record<IntakeSessionStatus, readonly IntakeSessionStatus[]>> = Object.freeze({
  draft: ["collecting", "cancelled"],
  collecting: ["awaiting_confirmation", "cancelled", "expired", "failed"],
  awaiting_confirmation: ["collecting", "confirmed", "cancelled", "expired", "failed"],
  confirmed: [], cancelled: [], expired: [], failed: ["collecting"],
});

export function assertSessionTransition(from: IntakeSessionStatus, to: IntakeSessionStatus) {
  if (!allowedSessionTransitions[from].includes(to)) {
    throw new IntakeCoreError("INTAKE_SESSION_TRANSITION_INVALID", "Intake session transition is not allowed", 409);
  }
}
