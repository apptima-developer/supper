export type SyncLockSnapshot = { lockToken?: string; lockedUntil?: string };

export function canAcquireSyncLock(snapshot: SyncLockSnapshot | undefined, token: string, now: string) {
  if (!snapshot?.lockToken || !snapshot.lockedUntil) return true;
  if (snapshot.lockToken === token) return true;
  return new Date(snapshot.lockedUntil).getTime() <= new Date(now).getTime();
}

export function canReleaseSyncLock(snapshot: SyncLockSnapshot | undefined, token: string) {
  return Boolean(snapshot?.lockToken && snapshot.lockToken === token);
}
