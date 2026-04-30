import { useEffect, useMemo, useState } from "react";
import { APT_USD_PYTH_FEED, D_METADATA, D_PACKAGE, D_PARAMS } from "../../config";
import { dIsSealed, dReadWarning } from "../../chain/d";
import { decodeDError } from "../../chain/dErrors";
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

const rpc = createRpcPool("d-about");

// Sealing proof tx — execute_transaction for destroy_cap, 2026-04-29.
const DESTROY_CAP_EXEC_SEQ = 625;
const PUBLISH_EXEC_TX =
  "0xdadc6b90";
const MULTISIG =
  "0x37f781195eb0929e5187ebe95dba5d9ac22859187a0ddca3e5afbc815688b826";

export function DAbout() {
  const [warning, setWarning] = useState<string | null>(null);
  const [sealed, setSealed] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [w, s] = await Promise.all([dReadWarning(rpc), dIsSealed(rpc)]);
        if (!cancelled) {
          setWarning(w);
          setSealed(s);
        }
      } catch (e) {
        if (!cancelled) setErr(decodeDError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <p className="page-sub">
        D is an immutable APT-collateralized stablecoin on Aptos. Retail-first
        (0.1 D minimum debt, no sorted list, flat 1% fee). Liquity-descendant
        design, Pyth-oracled, sealed on 2026-04-29 via destroy_cap from a 1/5
        multisig (raised to 3/5 post-seal for governance hygiene only — the
        ResourceCap is gone, multisig has zero protocol authority).
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
          <div className="protocol-note">Resource account, no signer cap</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Origin multisig</div>
          <div className="protocol-note" style={{ fontSize: 11 }}>
            <a
              href={`https://explorer.aptoslabs.com/account/${MULTISIG}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {MULTISIG.slice(0, 14)}…
            </a>
            {" · 3/5 (governance hygiene)"}
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">destroy_cap (seal)</div>
          <div className="protocol-note" style={{ fontSize: 11 }}>
            multisig seq {DESTROY_CAP_EXEC_SEQ} · publish tx {PUBLISH_EXEC_TX}…
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
          <span className="venue-out">{D_PARAMS.MCR_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Liquidation threshold</span>
          <span className="venue-out">{D_PARAMS.LIQ_THRESHOLD_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Liquidation bonus</span>
          <span className="venue-out">{D_PARAMS.LIQ_BONUS_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Flat mint + redeem fee</span>
          <span className="venue-out">{D_PARAMS.FEE_BPS / 100}%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Fee split (SP pool / keyed depositors)</span>
          <span className="venue-out">10% / 90%</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Pyth staleness ceiling</span>
          <span className="venue-out">{D_PARAMS.STALENESS_SECS}s</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">Min debt</span>
          <span className="venue-out">0.1 D</span>
        </div>
      </div>

      <h2 className="section-title">Addresses + oracle</h2>
      <div className="protocol-card">
        <div className="protocol-label">Package</div>
        <div className="protocol-addr">
          <a
            href={`https://explorer.aptoslabs.com/account/${D_PACKAGE}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {D_PACKAGE}
          </a>
        </div>
      </div>
      <div className="protocol-card">
        <div className="protocol-label">D FA metadata</div>
        <div className="protocol-addr">
          <a
            href={`https://explorer.aptoslabs.com/fungible_asset/${D_METADATA}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {D_METADATA}
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
