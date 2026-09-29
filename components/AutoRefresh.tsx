"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Refreshes the current route on an interval while `active` (used while capture processing is in flight). */
export function AutoRefresh({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
