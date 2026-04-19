'use client';

import { useEffect, useState } from 'react';
import { formatCountdown, secondsUntil } from '@/lib/format';

export function Countdown({ iso, className }: { iso: string; className?: string }) {
  const [sec, setSec] = useState(() => secondsUntil(iso));
  useEffect(() => {
    const id = setInterval(() => setSec(secondsUntil(iso)), 1000);
    return () => clearInterval(id);
  }, [iso]);
  return <span className={className}>{formatCountdown(sec)}</span>;
}
