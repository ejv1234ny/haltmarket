const MICRO = 1_000_000;

export function microToUsd(micro: number): number {
  return micro / MICRO;
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * MICRO);
}

export function formatUsd(micro: number, opts?: { compact?: boolean }): string {
  const usd = microToUsd(micro);
  if (opts?.compact && Math.abs(usd) >= 10_000) {
    return `$${(usd / 1000).toFixed(1)}k`;
  }
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatPrice(price: number): string {
  return price.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function secondsUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'closed';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
