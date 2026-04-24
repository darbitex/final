import { useEffect, useState } from "react";
import { ONE_METADATA, ONE_PACKAGE, ONE_PARAMS } from "../../config";
import {
  oneIsSealed,
  onePrice8dec,
  oneReserveBalance,
  oneTotals,
  type Totals,
} from "../../chain/one";
import { createRpcPool } from "../../chain/rpc-pool";
import { formatApt, formatAptUsd, formatOne } from "../../chain/oneFormat";

const rpc = createRpcPool("one-overview");

type State = {
  totals: Totals;
  priceRaw: bigint;
  sealed: boolean;
  reserveRaw: bigint;
} | null;

export function OneOverview() {
  const [state, setState] = useState<State>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [t, p, s, r] = await Promise.all([
          oneTotals(rpc),
          onePrice8dec(rpc),
          oneIsSealed(rpc),
          oneReserveBalance(rpc),
        ]);
        if (!cancelled) {
          setState({ totals: t, priceRaw: p, sealed: s, reserveRaw: r });
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message ?? String(e));
      }
    }

    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (err) return <div className="err">Error: {err}</div>;
  if (!state) return <div className="hint">Loading registry state…</div>;

  const { totals, priceRaw, sealed, reserveRaw } = state;
  const reserveUsd =
    (Number(reserveRaw) / 10 ** ONE_PARAMS.APT_DECIMALS) *
    (Number(priceRaw) / 1e8);

  return (
    <>
      <section className="protocol-grid">
        <div className="protocol-card small">
          <div className="protocol-label">APT / USD</div>
          <div className="protocol-big">{formatAptUsd(priceRaw)}</div>
          <div className="protocol-note">Pyth oracle, ≤60s stale</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Total debt (circulating claim)</div>
          <div className="protocol-big">{formatOne(totals.totalDebt)}</div>
          <div className="protocol-note">ONE</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Stability pool</div>
          <div className="protocol-big">{formatOne(totals.totalSp)}</div>
          <div className="protocol-note">ONE deposited</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Protocol reserve</div>
          <div className="protocol-big">{formatApt(reserveRaw)}</div>
          <div className="protocol-note">
            APT · ≈ ${reserveUsd.toFixed(2)}
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">MCR / LIQ / bonus / fee</div>
          <div className="protocol-big" style={{ fontSize: 18 }}>
            {ONE_PARAMS.MCR_BPS / 100}% / {ONE_PARAMS.LIQ_THRESHOLD_BPS / 100}% /{" "}
            {ONE_PARAMS.LIQ_BONUS_BPS / 100}% / {ONE_PARAMS.FEE_BPS / 100}%
          </div>
          <div className="protocol-note">locked at deploy · retail-first</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Sealed</div>
          <div className="protocol-big" style={{ fontSize: 18 }}>
            {sealed ? "immutable forever" : "⚠ cap not destroyed"}
          </div>
          <div className="protocol-note">
            {sealed
              ? "ResourceCap consumed; auth_key = 0x0"
              : "destroy_cap still available"}
          </div>
        </div>
      </section>

      <h2 className="section-title">Addresses</h2>
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
    </>
  );
}
