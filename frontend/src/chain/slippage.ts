import { useEffect, useState } from "react";
import { SLIPPAGE } from "../config";

const STORAGE_KEY = "darbitex.slippage";
const MIN = 0.0001;
const MAX = 0.5;

type Listener = (v: number) => void;
const listeners = new Set<Listener>();

function readStored(): number {
  if (typeof localStorage === "undefined") return SLIPPAGE;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return SLIPPAGE;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < MIN || n > MAX) return SLIPPAGE;
  return n;
}

let current = readStored();

export function getSlippage(): number {
  return current;
}

export function setSlippage(v: number): void {
  if (!Number.isFinite(v) || v < MIN || v > MAX) return;
  current = v;
  try {
    localStorage.setItem(STORAGE_KEY, String(v));
  } catch {
    // ignore
  }
  listeners.forEach((l) => l(v));
}

export function useSlippage(): [number, (v: number) => void] {
  const [value, setValue] = useState(current);
  useEffect(() => {
    const l: Listener = (v) => setValue(v);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return [value, setSlippage];
}
