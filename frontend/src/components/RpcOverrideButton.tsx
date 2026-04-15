import { useEffect, useRef, useState } from "react";

// UI wrapper over the darbitex.rpcOverride localStorage key. Completely
// optional — most users should leave this empty and let Darbitex use its
// bundled Geomi endpoint plus public Aptos Labs fallbacks. Only relevant
// for users who already pay for a private RPC (QuickNode, Alchemy, own
// fullnode) and want Darbitex to route through it. URLs are saved only
// in this browser's localStorage — never uploaded, never committed, not
// visible to other users of darbitex.wal.app.

const STORAGE_KEY = "darbitex.rpcOverride";

function readOverride(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // ignore
  }
  return [];
}

export function RpcOverrideButton() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(readOverride().join("\n"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function save() {
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("http"));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } catch {
      // ignore
    }
  }

  function clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setText("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  }

  function reload() {
    window.location.reload();
  }

  const active = readOverride().length > 0;

  return (
    <div className="slippage-wrap" ref={rootRef}>
      <button
        type="button"
        className={`slippage-btn${active ? " rpc-active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Custom RPC (optional)"
        aria-label="Custom RPC"
      >
        RPC
      </button>
      {open && (
        <div className="slippage-panel" style={{ minWidth: 340 }}>
          <div className="slippage-panel-title">Custom RPC (optional)</div>
          <div className="slippage-hint" style={{ marginBottom: 10 }}>
            <strong style={{ color: "#ddd" }}>You don't need this.</strong> Darbitex already
            ships with a bundled Geomi endpoint plus two public Aptos Labs fallbacks — the
            built-in rotation handles quotes and transactions for everyone. Use this only if
            you already pay for a private RPC (QuickNode, Alchemy, your own fullnode) and
            want Darbitex to route through it.
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://your-private-rpc.example.com/v1  (one URL per line)"
            rows={4}
            style={{
              width: "100%",
              background: "#0a0a0a",
              border: "1px solid #333",
              color: "#fff",
              padding: "8px",
              borderRadius: "6px",
              fontFamily: "inherit",
              fontSize: "11px",
              resize: "vertical",
              marginBottom: "8px",
            }}
          />
          <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
            <button type="button" className="slippage-apply" onClick={save}>
              Save
            </button>
            <button type="button" className="slippage-apply" onClick={clear}>
              Clear
            </button>
            <button type="button" className="slippage-apply" onClick={reload}>
              Reload
            </button>
          </div>
          {saved && (
            <div style={{ fontSize: 10, color: "#ff8800", marginBottom: 8 }}>
              Saved. Click Reload to apply.
            </div>
          )}
          <div className="slippage-hint">
            <strong style={{ color: "#ddd" }}>How to use:</strong>
            <ol style={{ margin: "6px 0 0 16px", padding: 0, lineHeight: 1.6 }}>
              <li>Paste one or more RPC URLs (one per line). Each must start with <code>http</code>.</li>
              <li>Click <em>Save</em> — URLs are written to this browser's localStorage.</li>
              <li>Click <em>Reload</em> — the page reloads and your URL is tried first in the rotation; the bundled endpoints are still used as fallback if yours errors.</li>
              <li>Click <em>Clear</em> to remove the override and go back to the defaults.</li>
            </ol>
            <div style={{ marginTop: 8, color: "#666" }}>
              Stored only in this browser (localStorage). Never uploaded, never committed, not
              visible to anyone else using darbitex.wal.app.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
