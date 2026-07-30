"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const DASHBOARD_REFRESH_INTERVAL_MS = 15_000;

export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const refreshInFlight = useRef(false);

  const refreshDashboard = useCallback(() => {
    if (document.visibilityState !== "visible" || refreshInFlight.current) {
      return;
    }

    refreshInFlight.current = true;
    router.refresh();

    // router.refresh() does not expose a completion promise. Keep refreshes bounded
    // so slow VPS summary requests cannot produce overlapping refresh storms.
    window.setTimeout(() => {
      refreshInFlight.current = false;
    }, 5_000);
  }, [router]);

  useEffect(() => {
    const interval = window.setInterval(refreshDashboard, DASHBOARD_REFRESH_INTERVAL_MS);
    const handleFocus = () => refreshDashboard();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshDashboard();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshDashboard]);

  return children;
}
