"use client";

import { useEffect, useRef, useState } from "react";

export const FLASH_MS = 600;

export interface Flash {
  dir: "up" | "down" | null;
  /** Increments on every price change; use as a React key to restart the CSS animation. */
  seq: number;
}

/**
 * Reports "up"/"down" for FLASH_MS after `value` rises/falls, then null.
 * The first value seen never flashes.
 */
export function useFlash(value: number | null | undefined): Flash {
  const prev = useRef(value);
  const [flash, setFlash] = useState<Flash>({ dir: null, seq: 0 });

  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (before == null || value == null || before === value) return;
    const dir = value > before ? "up" : "down";
    setFlash((f) => ({ dir, seq: f.seq + 1 }));
  }, [value]);

  useEffect(() => {
    if (!flash.dir) return;
    const id = setTimeout(() => setFlash((f) => ({ ...f, dir: null })), FLASH_MS);
    return () => clearTimeout(id);
  }, [flash.dir, flash.seq]);

  return flash;
}
