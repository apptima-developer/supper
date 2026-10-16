export function capacityStatus(bytes, capacityMb = 500, warningPercent = 80, warned = false) {
  if (![bytes, capacityMb, warningPercent].every(Number.isFinite) || bytes < 0 || capacityMb <= 0 || warningPercent <= 0 || warningPercent > 100) throw new Error('Invalid capacity configuration');
  // MB is decimal: the configured 500 MB is exactly 500,000,000 bytes.
  const usagePercent = bytes / (capacityMb * 1_000_000) * 100;
  const warning = usagePercent >= warningPercent;
  return { databaseBytes: bytes, capacityMb, warningPercent, usagePercent, status: warning ? 'WARNING' : 'HEALTHY', sendAlert: warning && !warned, warned: warning };
}
