import { useEffect, useRef, useState } from "react";
import { listEvents } from "./api";
import type { Event } from "./types";

const POLL_MS = 3000;

export interface UseEvents {
  events: Event[];
  loading: boolean;
}

export function useEvents(id: string | null): UseEvents {
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!id) {
      setEvents([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    inFlight.current = false;

    const load = async (initial: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      if (initial) setLoading(true);
      try {
        const next = await listEvents(id);
        if (!cancelled) setEvents(next);
      } catch {
        // keep the last good timeline; connection errors surface in the rail health dot
      } finally {
        if (!cancelled && initial) setLoading(false);
        inFlight.current = false;
      }
    };

    setEvents([]);
    void load(true);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  return { events, loading };
}
