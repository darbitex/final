import { useEffect, useRef, useState } from "react";
import { useSlippage } from "../chain/slippage";

const PRESETS = [0.001, 0.005, 0.01];

export function SlippageButton() {
  const [slippage, setSlippage] = useSlippage();
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function applyCustom() {
    const n = Number.parseFloat(customInput);
    if (!Number.isFinite(n) || n <= 0) return;
    setSlippage(n / 100);
    setCustomInput("");
  }

  const pct = (slippage * 100).toFixed(slippage < 0.01 ? 2 : 1);

  return (
    <div className="slippage-wrap" ref={rootRef}>
      <button
        type="button"
        className="slippage-btn"
        onClick={() => setOpen((o) => !o)}
        title={`Slippage tolerance: ${pct}%`}
        aria-label="Slippage settings"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span className="slippage-val">{pct}%</span>
      </button>
      {open && (
        <div className="slippage-panel">
          <div className="slippage-panel-title">Slippage tolerance</div>
          <div className="slippage-presets">
            {PRESETS.map((p) => {
              const active = Math.abs(p - slippage) < 1e-9;
              return (
                <button
                  key={p}
                  type="button"
                  className={`slippage-preset${active ? " active" : ""}`}
                  onClick={() => setSlippage(p)}
                >
                  {(p * 100).toFixed(p < 0.01 ? 2 : 1)}%
                </button>
              );
            })}
          </div>
          <div className="slippage-custom">
            <input
              type="number"
              placeholder="Custom %"
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") applyCustom();
              }}
              step="0.01"
              min="0.01"
              max="50"
            />
            <button type="button" className="slippage-apply" onClick={applyCustom}>
              Set
            </button>
          </div>
          <div className="slippage-hint">
            Applies to swaps and LP add/remove. Range 0.01%–50%.
          </div>
        </div>
      )}
    </div>
  );
}
