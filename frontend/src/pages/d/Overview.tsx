import { useEffect, useState } from "react";
import { D_METADATA, D_PACKAGE, D_PARAMS, D_STORES } from "../../config";
import {
  dIsSealed,
  dPrice8dec,
  dReserveBalance,
  dSpPoolBalance,
  dTotals,
  faStoreBalance,
  type Totals,
} from "../../chain/d";
import { createRpcPool } from "../../chain/rpc-pool";
import { formatApt, formatAptUsd, formatD } from "../../chain/dFormat";

const rpc = createRpcPool("d-overview");

type State = {
  totals: Totals;
  priceRaw: bigint;
  sealed: boolean;
  reserveRaw: bigint;
  spPoolRaw: bigint;
  feePoolRaw: bigint;
  spCollPoolRaw: bigint;
  treasuryRaw: bigint;
} | null;

export function DOverview() {
  const [state, setState] = useState<State>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // 5 protocol stores. reserve_balance + sp_pool_balance go through
        // dedicated D views (cheaper / more idiomatic). The other 3 — fee_pool,
        // sp_coll_pool, treasury — D doesn't expose, so we read FungibleStore
        // balance directly via 0x1::fungible_asset::balance.
        const [t, p, s, reserveRaw, spPoolRaw, feePoolRaw, spCollPoolRaw, treasuryRaw] =
          await Promise.all([
            dTotals(rpc),
            dPrice8dec(rpc),
            dIsSealed(rpc),
            dReserveBalance(rpc),
            dSpPoolBalance(rpc),
            faStoreBalance(rpc, D_STORES.fee_pool),
            faStoreBalance(rpc, D_STORES.sp_coll_pool),
            faStoreBalance(rpc, D_STORES.treasury),
          ]);
        if (!cancelled) {
          setState({
            totals: t,
            priceRaw: p,
            sealed: s,
            reserveRaw,
            spPoolRaw,
            feePoolRaw,
            spCollPoolRaw,
            treasuryRaw,
          });
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

  const {
    totals,
    priceRaw,
    sealed,
    reserveRaw,
    spPoolRaw,
    feePoolRaw,
    spCollPoolRaw,
    treasuryRaw,
  } = state;
  const reserveUsd =
    (Number(reserveRaw) / 10 ** D_PARAMS.APT_DECIMALS) *
    (Number(priceRaw) / 1e8);
  const treasuryUsd =
    (Number(treasuryRaw) / 10 ** D_PARAMS.APT_DECIMALS) *
    (Number(priceRaw) / 1e8);
  const spDonationDelta = spPoolRaw - totals.totalSp;

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
          <div className="protocol-big">{formatD(totals.totalDebt)}</div>
          <div className="protocol-note">D</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Stability pool (keyed)</div>
          <div className="protocol-big">{formatD(totals.totalSp)}</div>
          <div className="protocol-note">D earning rewards</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">SP pool balance</div>
          <div className="protocol-big">{formatD(spPoolRaw)}</div>
          <div className="protocol-note">
            +{formatD(spDonationDelta > 0n ? spDonationDelta : 0n, 6)} D donations
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">MCR / LIQ / bonus / fee</div>
          <div className="protocol-big" style={{ fontSize: 18 }}>
            {D_PARAMS.MCR_BPS / 100}% / {D_PARAMS.LIQ_THRESHOLD_BPS / 100}% /{" "}
            {D_PARAMS.LIQ_BONUS_BPS / 100}% / {D_PARAMS.FEE_BPS / 100}%
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

      <h2 className="section-title">Protocol balance sheet</h2>
      <p className="page-sub">
        Live FungibleStore balances for all 5 protocol-owned stores. Read via
        on-chain D views (sp_pool / reserve_coll) and{" "}
        <code>0x1::fungible_asset::balance</code> for the remaining 3.
      </p>
      <div className="venue-table">
        <div className="venue-head">
          <span>Store</span>
          <span>Balance</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">treasury (APT collateral)</span>
          <span className="venue-out">
            {formatApt(treasuryRaw)} APT · ≈ ${treasuryUsd.toFixed(2)}
          </span>
        </div>
        <div className="venue-row">
          <span className="venue-name">reserve_coll (APT for reserve-redeems)</span>
          <span className="venue-out">
            {formatApt(reserveRaw)} APT · ≈ ${reserveUsd.toFixed(2)}
          </span>
        </div>
        <div className="venue-row">
          <span className="venue-name">sp_pool (D for liq absorption)</span>
          <span className="venue-out">{formatD(spPoolRaw)} D</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">sp_coll_pool (APT seized for SP keyed)</span>
          <span className="venue-out">{formatApt(spCollPoolRaw)} APT</span>
        </div>
        <div className="venue-row">
          <span className="venue-name">fee_pool (D fee accumulator for SP keyed)</span>
          <span className="venue-out">{formatD(feePoolRaw)} D</span>
        </div>
      </div>

      <h2 className="section-title">Addresses</h2>
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
    </>
  );
}
