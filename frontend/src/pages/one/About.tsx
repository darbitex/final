import { useEffect, useMemo, useState } from "react";
import { APT_USD_PYTH_FEED, ONE_METADATA, ONE_PACKAGE, ONE_PARAMS } from "../../config";
import { oneIsSealed, oneReadWarning } from "../../chain/one";
import { decodeOneError } from "../../chain/oneErrors";
import { createRpcPool } from "../../chain/rpc-pool";

// The on-chain WARNING is a single flat string with 9 numbered points
// prefixed "(1) ... (2) ... (9) ...". Split at each "(N) " marker so we
// can render the number in red and give each clause its own block with
// breathing room.
function parseWarning(raw: string): { preamble: string; points: { num: string; body: string }[] } {
  const parts = raw.split(/(?=\(\d+\))/);
  const preamble = (parts[0] ?? "").trim();
  const points: { num: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i].match(/^\((\d+)\)\s*([\s\S]*)$/);
    if (m) points.push({ num: m[1], body: m[2].trim() });
  }
  return { preamble, points };
}

function WarningBlock({ raw }: { raw: string }) {
  const { preamble, points } = useMemo(() => parseWarning(raw), [raw]);
  return (
    <div style={{ fontSize: 13, color: "#b0b0b0", lineHeight: 1.65 }}>
      <p style={{ margin: 0 }}>{preamble}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
        {points.map((p) => (
          <div key={p.num} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span
              style={{
                color: "#ff6b6b",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                minWidth: 24,
                textAlign: "right",
                flexShrink: 0,
              }}
            >
              ({p.num})
            </span>
            <span style={{ flex: 1 }}>{p.body}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const rpc = createRpcPool("one-about");

// Sealing proof tx — destroy_cap, published 2026-04-24.
const DESTROY_CAP_TX =
  "0x529f06dbd5d21ff361e96993545c70a07fb35893024f23155f9daef6b2954fbb";
const PUBLISH_TX =
  "0xf087e928dbf8cf4232cb054bc07138efc4c5d4b796368ef96204f6feaecf3126";

export function OneAbout() {
  const [warning, setWarning] = useState<string | null>(null);
  const [sealed, setSealed] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, s] = await Promise.all([oneReadWarning(rpc), oneIsSealed(rpc)]);
        if (!cancelled) {
          setWarning(w);
          setSealed(s);
        }
      } catch (e) {
        if (!cancelled) setErr(decodeOneError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <p className="page-sub">
        ONE is an immutable APT-collateralized stablecoin on Aptos. Retail-first
        (1 ONE minimum debt, no sorted list, flat 1% fee). Liquity-descendant
        design, Pyth-oracled, sealed on 2026-04-24.
      </p>

      <h2 className="section-title">On-chain WARNING</h2>
      <div className="card" style={{ padding: 16 }}>
        {err && <div className="err">{err}</div>}
        {!warning && !err && <div className="hint">Loading WARNING from chain…</div>}
        {warning && <WarningBlock raw={warning} />}
      </div>

      <h2 className="section-title">Immutability proof</h2>
      <section className="protocol-grid">
        <div className="protocol-card small">
          <div className="protocol-label">ResourceCap sealed</div>
          <div className="protocol-big" style={{ fontSize: 18 }}>
            {sealed === null ? "…" : sealed ? "✓ YES" : "⚠ NO"}
          </div>
          <div className="protocol-note">
            <code>is_sealed()</code> live on-chain
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">auth_key</div>
          <div className="protocol-big" style={{ fontSize: 18 }}>
            0x0…0
          </div>
          <div className="protocol-note">Package cannot be upgraded</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Publish tx</div>
          <div className="protocol-note" style={{ fontSize: 11 }}>
            <a
              href={`https://explorer.aptoslabs.com/txn/${PUBLISH_TX}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PUBLISH_TX.slice(0, 14)}…
            </a>
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">destroy_cap tx (seal)</div>
          <div className="protocol-note" style={{ fontSize: 11 }}>
            <a
              href={`https://explorer.aptoslabs.com/txn/${DESTROY_CAP_TX}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {DESTROY_CAP_TX.slice(0, 14)}…
            </a>
          </div>
        </div>
      </section>

      <h2 className="section-title">Protocol parameters (locked)</h2>
      <div className="venue-table">
        <div className="venue-head">
          <span>Parameter</span>
          <span>Value</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">MCR (open / augment)</span>
          <span className="venue-out">{ONE_PARAMS.MCR_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Liquidation threshold</span>
          <span className="venue-out">{ONE_PARAMS.LIQ_THRESHOLD_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Liquidation bonus</span>
          <span className="venue-out">{ONE_PARAMS.LIQ_BONUS_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Flat mint + redeem fee</span>
          <span className="venue-out">{ONE_PARAMS.FEE_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Pyth staleness ceiling</span>
          <span className="venue-out">{ONE_PARAMS.STALENESS_SECS}s</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Min debt</span>
          <span className="venue-out">1 ONE</span>
        </div>
      </div>

      <h2 className="section-title">Addresses + oracle</h2>
      <div className="protocol-card">
        <div className="protocol-label">Package</div>
        <div className="protocol-addr">
          <a
            href={`https://explorer.aptoslabs.com/account/${ONE_PACKAGE}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {ONE_PACKAGE}
          </a>
        </div>
      </div>
      <div className="protocol-card">
        <div className="protocol-label">ONE FA metadata</div>
        <div className="protocol-addr">
          <a
            href={`https://explorer.aptoslabs.com/fungible_asset/${ONE_METADATA}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {ONE_METADATA}
          </a>
        </div>
      </div>
      <div className="protocol-card">
        <div className="protocol-label">Pyth APT/USD feed id</div>
        <div className="protocol-addr">
          <a
            href={`https://pyth.network/developers/price-feed-ids#aptos-mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {APT_USD_PYTH_FEED}
          </a>
        </div>
      </div>
    </>
  );
}
