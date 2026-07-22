export const MAX_CANONICAL_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const MIN_CANONICAL_SAFE_INTEGER = Number.MIN_SAFE_INTEGER;

export function assertCanonicalIntakeNumbers(value: unknown): void {
  const ancestors = new WeakSet<object>();

  function visit(current: unknown, depth: number): void {
    if (depth > 16) throw new TypeError("INTAKE_CANONICAL_NUMBER_INVALID: JSON exceeds the canonical depth limit");
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current)) {
        throw new TypeError("INTAKE_CANONICAL_NUMBER_INVALID: Canonical JSON numbers must be safe integers");
      }
      return;
    }
    if (!current || typeof current !== "object") return;
    if (ancestors.has(current)) throw new TypeError("INTAKE_CANONICAL_NUMBER_INVALID: Canonical JSON contains a cycle");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        for (const item of current) visit(item, depth + 1);
        return;
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor && !descriptor.get && !descriptor.set) visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, 0);
}
