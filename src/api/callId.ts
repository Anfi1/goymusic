export function createCallId(): string {
  const cryptoObj = (globalThis as any).crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();

  // Fallback: unique-enough for single-client use (time + randomness)
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

