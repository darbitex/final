import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { fetchFaBalance } from "../../chain/balance";
import { createRpcPool } from "../../chain/rpc-pool";
import { handleOf } from "../../chain/desnet/profile";
import { shortAddr } from "../../chain/desnet/format";
import {
  DEPOSIT_BALANCED_FN,
  DEPOSIT_PICK_SIDE_FN,
  REDEEM_COMPLETE_SET_FN,
  SIDE_NAY,
  SIDE_YAY,
  SWAP_NAY_FOR_YAY_FN,
  SWAP_YAY_FOR_NAY_FN,
  computeAmountOutLocal,
  computeTaxLocal,
  creatorInitialMc,
  creatorTokenOf,
  depositBalancedArgs,
  depositPickSideArgs,
  formatTokenAmount,
  marketAddrOf,
  marketExists,
  poolReserves,
  redeemCompleteSetArgs,
  swapNayForYayArgs,
  swapYayForNayArgs,
  taxBpsOf,
  tokenAddrs,
  totalSupplies,
  vaultBalance,
  wholeToRaw,
  type PoolReserves,
  type Supplies,
  type TokenAddrs,
} from "../../chain/desnet/opinion";

const rpc = createRpcPool("desnet-opinion");

type MarketSnapshot = {
  pid: string;
  seq: number;
  marketAddr: string;
  authorHandle: string | null;
  creatorToken: string;
  initialMc: bigint;
  taxBps: number;
  vault: bigint;
  pool: PoolReserves;
  supplies: Supplies;
  tokens: TokenAddrs;
};

export function Opinion() {
  const { author, seq: seqParam } = useParams<{ author: string; seq: string }>();
  const seq = useMemo(() => Number(seqParam ?? "NaN"), [seqParam]);

  const [exists, setExists] = useState<boolean | null>(null);
  const [snap, setSnap] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  // Top-level existence + snapshot loader
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!author || !Number.isFinite(seq) || seq < 0) {
      setExists(false);
      return;
    }
    setExists(null);
    setSnap(null);
    (async () => {
      try {
        const ok = await marketExists(rpc, author, seq);
        if (cancelled) return;
        setExists(ok);
        if (!ok) return;
        const [marketAddr, creatorToken, initialMc, taxBps, vault, pool, supplies, tokens, handle] =
          await Promise.all([
            marketAddrOf(rpc, author, seq),
            creatorTokenOf(rpc, author, seq),
            creatorInitialMc(rpc, author, seq),
            taxBpsOf(rpc, author, seq),
            vaultBalance(rpc, author, seq),
            poolReserves(rpc, author, seq),
            totalSupplies(rpc, author, seq),
            tokenAddrs(rpc, author, seq),
            handleOf(rpc, author).catch(() => null),
          ]);
        if (cancelled) return;
        setSnap({
          pid: author,
          seq,
          marketAddr,
          authorHandle: handle,
          creatorToken,
          initialMc,
          taxBps,
          vault,
          pool,
          supplies,
          tokens,
        });
      } catch (e) {
        // Audit C MED-1: also flip exists → false on initial-load failure so
        // the error UI surfaces. Without this, exists stays null forever and
        // the page is stuck on "Loading market…" with no recourse.
        if (!cancelled) {
          setError((e as Error).message ?? String(e));
          setExists(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [author, seq, loadTick]);

  if (!author || !Number.isFinite(seq) || seq < 0) {
    return (
      <div className="card">
        <h2>Opinion market</h2>
        <p className="error">Invalid URL — expected /desnet/opinion/:author/:seq</p>
      </div>
    );
  }

  if (exists === null) return <div className="page-loading">Loading market…</div>;
  if (exists === false) {
    return (
      <div className="card">
        <h2>No market at {shortAddr(author)} #{seq}</h2>
        <p className="muted">
          Either this mint is a regular post (no opinion attached), the seq doesn't exist, or
          the address isn't a registered PID. Go back to <Link to="/desnet">/desnet</Link>.
        </p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }
  if (!snap) return <div className="page-loading">Loading…</div>;

  return (
    <div>
      {snap.authorHandle === null && (
        <div className="card" style={{ borderLeft: "4px solid #d97706", background: "#1a1100" }}>
          <strong style={{ color: "#fbbf24" }}>⚠ Unregistered PID</strong>
          <p className="muted small" style={{ margin: "4px 0 0 0" }}>
            This market's author PID has no registered handle. You may have followed a phishing
            link. Trading here is technically safe (chain enforces wallet auth) but every
            interaction burns 0.1% of <code>${shortAddr(snap.creatorToken)}</code> as tax —
            verify the market is legit before proceeding.
          </p>
        </div>
      )}
      <Header snap={snap} />
      <Stats snap={snap} />
      <TradePanel snap={snap} onMutate={() => setLoadTick((t) => t + 1)} />
    </div>
  );
}

// ============ Header ============

function Header({ snap }: { snap: MarketSnapshot }) {
  const handleLabel = snap.authorHandle ? `@${snap.authorHandle}` : shortAddr(snap.pid);
  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>Opinion market #{snap.seq}</h2>
      <p className="muted small" style={{ marginTop: 4 }}>
        by{" "}
        {snap.authorHandle ? (
          <Link to={`/desnet/p/${snap.authorHandle}`}>{handleLabel}</Link>
        ) : (
          <span>{handleLabel}</span>
        )}{" "}
        · denominated in{" "}
        {snap.authorHandle ? <code>${snap.authorHandle}</code> : <code>{shortAddr(snap.creatorToken)}</code>}{" "}
        · tax {snap.taxBps / 100}% per trade (creator-token burn)
      </p>
      <p className="muted small">
        Market addr:{" "}
        <a
          href={`https://explorer.aptoslabs.com/object/${snap.marketAddr}?network=mainnet`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortAddr(snap.marketAddr)}
        </a>
      </p>
    </div>
  );
}

// ============ Stats ============

function Stats({ snap }: { snap: MarketSnapshot }) {
  const conserved =
    snap.vault === snap.supplies.totalYay && snap.vault === snap.supplies.totalNay;
  const denom = snap.pool.yay + snap.pool.nay;
  const yayPct = denom > 0n ? Number((snap.pool.nay * 10000n) / denom) / 100 : 50;
  const nayPct = 100 - yayPct;

  return (
    <div className="card">
      <h3>State</h3>
      <table className="about-table">
        <tbody>
          <tr>
            <td>Vault collateral</td>
            <td className="mono">{formatTokenAmount(snap.vault)}</td>
          </tr>
          <tr>
            <td>Total YAY supply</td>
            <td className="mono">{formatTokenAmount(snap.supplies.totalYay)}</td>
          </tr>
          <tr>
            <td>Total NAY supply</td>
            <td className="mono">{formatTokenAmount(snap.supplies.totalNay)}</td>
          </tr>
          <tr>
            <td>Conservation invariant</td>
            <td className={conserved ? "ok" : "error"}>
              {conserved ? "✓ holds" : "✗ broken (should never happen)"}
            </td>
          </tr>
          <tr>
            <td>Pool YAY reserve</td>
            <td className="mono">{formatTokenAmount(snap.pool.yay)}</td>
          </tr>
          <tr>
            <td>Pool NAY reserve</td>
            <td className="mono">{formatTokenAmount(snap.pool.nay)}</td>
          </tr>
          <tr>
            <td>Implied YAY belief</td>
            <td>
              <strong>{yayPct.toFixed(2)}%</strong>
              {" / "}
              <strong>{nayPct.toFixed(2)}%</strong> NAY
            </td>
          </tr>
          <tr>
            <td>Initial seed (creator commit)</td>
            <td className="mono">{formatTokenAmount(snap.initialMc)}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        Implied belief = pool's NAY share of total reserves (1 YAY costs ≈ this fraction of a creator-token).
        Both sides re-price on every trade. Pool can drift arbitrarily; conservation invariant always holds.
      </p>
    </div>
  );
}

// ============ Trade panel ============

type TradeMode = "deposit-yay" | "deposit-nay" | "balanced" | "swap-y2n" | "swap-n2y" | "redeem";

function TradePanel({ snap, onMutate }: { snap: MarketSnapshot; onMutate: () => void }) {
  const myAddr = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [mode, setMode] = useState<TradeMode>("deposit-yay");
  const [amountInput, setAmountInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  // Connected-wallet balances for the 3 relevant tokens.
  const [balances, setBalances] = useState<{ creator: bigint; yay: bigint; nay: bigint }>({
    creator: 0n, yay: 0n, nay: 0n,
  });
  useEffect(() => {
    let cancelled = false;
    if (!myAddr) {
      setBalances({ creator: 0n, yay: 0n, nay: 0n });
      return;
    }
    Promise.all([
      fetchFaBalance(myAddr, snap.creatorToken).catch(() => 0n),
      fetchFaBalance(myAddr, snap.tokens.yay).catch(() => 0n),
      fetchFaBalance(myAddr, snap.tokens.nay).catch(() => 0n),
    ]).then(([c, y, n]) => {
      if (!cancelled) setBalances({ creator: c, yay: y, nay: n });
    });
    return () => { cancelled = true; };
  }, [myAddr, snap.creatorToken, snap.tokens.yay, snap.tokens.nay, lastTx]);

  // Parse user input → raw u64. null on invalid.
  const amountRaw: bigint | null = useMemo(() => {
    if (!amountInput.trim()) return null;
    try {
      return wholeToRaw(amountInput);
    } catch {
      return null;
    }
  }, [amountInput]);

  // Per-mode validation + previews.
  const preview = useMemo(() => previewFor(mode, amountRaw, snap, balances), [mode, amountRaw, snap, balances]);

  const canSubmit = !!myAddr && preview.ok && !submitting;

  async function submit() {
    if (!amountRaw) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const fn = MODE_FN[mode];
      const args = MODE_ARGS_BUILDER[mode](snap, amountRaw, preview.minOut ?? 0n);
      const r = await signAndSubmitTransaction({
        data: { function: fn, typeArguments: [], functionArguments: args },
      });
      setLastTx(r.hash);
      setAmountInput("");
      onMutate();
    } catch (e) {
      setError(decodeOpinionError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Trade</h3>

      <fieldset className="lock-pick">
        <legend>Action</legend>
        <label><input type="radio" checked={mode === "deposit-yay"} onChange={() => setMode("deposit-yay")} /> Deposit YAY (pick yes)</label>
        <label><input type="radio" checked={mode === "deposit-nay"} onChange={() => setMode("deposit-nay")} /> Deposit NAY (pick no)</label>
        <label><input type="radio" checked={mode === "balanced"} onChange={() => setMode("balanced")} /> Deposit balanced (mint pair)</label>
        <label><input type="radio" checked={mode === "swap-y2n"} onChange={() => setMode("swap-y2n")} /> Swap YAY → NAY</label>
        <label><input type="radio" checked={mode === "swap-n2y"} onChange={() => setMode("swap-n2y")} /> Swap NAY → YAY</label>
        <label><input type="radio" checked={mode === "redeem"} onChange={() => setMode("redeem")} /> Redeem complete set</label>
      </fieldset>

      <p className="muted small">{MODE_DESCRIPTION[mode](snap.authorHandle ?? "creator")}</p>

      <label className="field">
        <span>{MODE_AMOUNT_LABEL[mode](snap.authorHandle ?? "creator")}</span>
        <input
          type="number"
          min="0"
          step="any"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          placeholder="0.0"
        />
        {amountRaw !== null && (
          <small className="muted">= {amountRaw.toString()} raw</small>
        )}
      </label>

      <div className="muted small" style={{ marginTop: 6 }}>
        <strong>Your balances:</strong>{" "}
        ${snap.authorHandle ?? "creator"}: <code>{formatTokenAmount(balances.creator)}</code> ·{" "}
        YAY: <code>{formatTokenAmount(balances.yay)}</code> ·{" "}
        NAY: <code>{formatTokenAmount(balances.nay)}</code>
      </div>

      {amountRaw !== null && (
        <div className="card-stat" style={{ marginTop: 12, padding: 8, background: "#0a0a0a" }}>
          <strong>Preview</strong>
          <ul style={{ margin: "4px 0 0 18px" }}>
            {preview.lines.map((l, i) => (
              <li key={i} className={l.kind === "warn" ? "error" : ""}>
                {l.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!preview.ok && amountRaw !== null && (
        <p className="error small" style={{ marginTop: 8 }}>{preview.reason}</p>
      )}

      <button className="primary" disabled={!canSubmit} onClick={submit} style={{ marginTop: 12 }}>
        {submitting ? "Submitting…" : MODE_BUTTON[mode]}
      </button>

      {lastTx && (
        <p className="ok" style={{ marginTop: 8 }}>
          Done.{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
    </div>
  );
}

// ============ Mode tables ============

const MODE_FN: Record<TradeMode, string> = {
  "deposit-yay": DEPOSIT_PICK_SIDE_FN,
  "deposit-nay": DEPOSIT_PICK_SIDE_FN,
  balanced: DEPOSIT_BALANCED_FN,
  "swap-y2n": SWAP_YAY_FOR_NAY_FN,
  "swap-n2y": SWAP_NAY_FOR_YAY_FN,
  redeem: REDEEM_COMPLETE_SET_FN,
};

const MODE_ARGS_BUILDER: Record<
  TradeMode,
  (snap: MarketSnapshot, amount: bigint, minOut: bigint) => unknown[]
> = {
  "deposit-yay": (s, a) => depositPickSideArgs(s.pid, s.seq, SIDE_YAY, a),
  "deposit-nay": (s, a) => depositPickSideArgs(s.pid, s.seq, SIDE_NAY, a),
  balanced: (s, a) => depositBalancedArgs(s.pid, s.seq, a),
  "swap-y2n": (s, a, minOut) => swapYayForNayArgs(s.pid, s.seq, a, minOut),
  "swap-n2y": (s, a, minOut) => swapNayForYayArgs(s.pid, s.seq, a, minOut),
  redeem: (s, a) => redeemCompleteSetArgs(s.pid, s.seq, a),
};

const MODE_BUTTON: Record<TradeMode, string> = {
  "deposit-yay": "Deposit (keep YAY)",
  "deposit-nay": "Deposit (keep NAY)",
  balanced: "Deposit balanced",
  "swap-y2n": "Swap YAY → NAY",
  "swap-n2y": "Swap NAY → YAY",
  redeem: "Redeem complete set",
};

const MODE_AMOUNT_LABEL: Record<TradeMode, (h: string) => string> = {
  "deposit-yay": (h) => `Amount of $${h} to deposit`,
  "deposit-nay": (h) => `Amount of $${h} to deposit`,
  balanced: (h) => `Amount of $${h} to deposit`,
  "swap-y2n": () => `YAY in`,
  "swap-n2y": () => `NAY in`,
  redeem: (h) => `Amount of pair to burn (gives back $${h} from vault)`,
};

const MODE_DESCRIPTION: Record<TradeMode, (h: string) => string> = {
  "deposit-yay": (h) =>
    `Pull $${h} from your wallet → vault. Mint amount YAY + amount NAY. You keep the YAY; pool absorbs the NAY (price moves toward NAY-cheap). ⚠ This donates HALF your mint (the NAY side) to pool depth — for pure YAY exposure, use 'Balanced' + 'Swap NAY → YAY' instead to get ~2× the YAY for the same $${h}.`,
  "deposit-nay": (h) =>
    `Pull $${h} from your wallet → vault. Mint amount YAY + amount NAY. You keep the NAY; pool absorbs the YAY (price moves toward YAY-cheap). ⚠ This donates HALF your mint (the YAY side) to pool depth — for pure NAY exposure, use 'Balanced' + 'Swap YAY → NAY' instead to get ~2× the NAY for the same $${h}.`,
  balanced: (h) =>
    `Pull $${h} from your wallet → vault. Mint amount YAY + amount NAY. You receive BOTH sides 1:1. Pool reserves unchanged. Best primitive for accumulating a redeemable pair, or as the first leg before a swap.`,
  "swap-y2n": (h) =>
    `Trade YAY for NAY through the x*y=k pool. Spot-equivalent tax in $${h} burned (separate from amount_in — you must hold $${h} in your wallet for the tax burn). Slippage tolerance enforced server-side.`,
  "swap-n2y": (h) =>
    `Trade NAY for YAY through the x*y=k pool. Spot-equivalent tax in $${h} burned (separate from amount_in — you must hold $${h} in your wallet for the tax burn). Slippage tolerance enforced server-side.`,
  redeem: (h) =>
    `Burn amount YAY + amount NAY from your wallet. Receive amount $${h} back from the vault, minus the tax skim. Always-exit guarantee. Tax comes out of vault output — you do NOT need extra $${h} in your wallet.`,
};

// ============ Per-mode preview + validation ============

type Preview = {
  ok: boolean;
  reason?: string;
  minOut?: bigint;
  lines: { kind: "info" | "warn"; text: string }[];
};

function previewFor(
  mode: TradeMode,
  amountRaw: bigint | null,
  snap: MarketSnapshot,
  bal: { creator: bigint; yay: bigint; nay: bigint },
): Preview {
  const lines: Preview["lines"] = [];
  if (amountRaw === null) return { ok: false, reason: "Enter a positive amount.", lines };
  if (amountRaw <= 0n) return { ok: false, reason: "Amount must be > 0.", lines };

  if (mode === "deposit-yay" || mode === "deposit-nay") {
    const tax = computeTaxLocal(amountRaw, snap.taxBps);
    const totalNeeded = amountRaw + tax;
    if (bal.creator < totalNeeded) {
      return {
        ok: false,
        reason: `Insufficient $creator balance (have ${formatTokenAmount(bal.creator)}, need ${formatTokenAmount(amountRaw)} for vault + ${formatTokenAmount(tax)} for tax burn = ${formatTokenAmount(totalNeeded)} total).`,
        lines,
      };
    }
    lines.push({ kind: "info", text: `Vault grows by ${formatTokenAmount(amountRaw)}` });
    lines.push({
      kind: "info",
      text:
        mode === "deposit-yay"
          ? `Pool NAY grows by ${formatTokenAmount(amountRaw)}; pool YAY unchanged. You receive ${formatTokenAmount(amountRaw)} YAY.`
          : `Pool YAY grows by ${formatTokenAmount(amountRaw)}; pool NAY unchanged. You receive ${formatTokenAmount(amountRaw)} NAY.`,
    });
    lines.push({ kind: "info", text: `Additional ${formatTokenAmount(tax)} $creator burned (tax)` });
    return { ok: true, lines };
  }

  if (mode === "balanced") {
    const tax = computeTaxLocal(amountRaw, snap.taxBps);
    const totalNeeded = amountRaw + tax;
    if (bal.creator < totalNeeded) {
      return {
        ok: false,
        reason: `Insufficient $creator balance (have ${formatTokenAmount(bal.creator)}, need ${formatTokenAmount(amountRaw)} for vault + ${formatTokenAmount(tax)} for tax burn = ${formatTokenAmount(totalNeeded)} total).`,
        lines,
      };
    }
    lines.push({ kind: "info", text: `Vault grows by ${formatTokenAmount(amountRaw)}` });
    lines.push({ kind: "info", text: `You receive ${formatTokenAmount(amountRaw)} YAY + ${formatTokenAmount(amountRaw)} NAY (pool reserves unchanged)` });
    lines.push({ kind: "info", text: `Additional ${formatTokenAmount(tax)} $creator burned (tax)` });
    return { ok: true, lines };
  }

  if (mode === "swap-y2n" || mode === "swap-n2y") {
    const have = mode === "swap-y2n" ? bal.yay : bal.nay;
    const haveLabel = mode === "swap-y2n" ? "YAY" : "NAY";
    if (have < amountRaw) {
      return {
        ok: false,
        reason: `Insufficient ${haveLabel} balance (have ${formatTokenAmount(have)}, need ${formatTokenAmount(amountRaw)}).`,
        lines,
      };
    }
    const reserveIn = mode === "swap-y2n" ? snap.pool.yay : snap.pool.nay;
    const reserveOut = mode === "swap-y2n" ? snap.pool.nay : snap.pool.yay;
    const out = computeAmountOutLocal(reserveIn, reserveOut, amountRaw);
    if (out === 0n) {
      return {
        ok: false,
        reason: `Swap output truncates to zero at this pool depth. Try a larger input or wait for the pool to rebalance.`,
        lines,
      };
    }
    // Spot-equivalent tax base (mirrors rc2 D-M1).
    const denom = reserveIn + reserveOut;
    const spotTokenEquiv = denom > 0n ? (amountRaw * reserveOut) / denom : 0n;
    const tax = computeTaxLocal(spotTokenEquiv, snap.taxBps);
    if (bal.creator < tax) {
      return {
        ok: false,
        reason: `Insufficient $creator for swap tax. Swaps burn ${formatTokenAmount(tax)} $creator (spot-equivalent of your ${haveLabel} input). You hold ${formatTokenAmount(bal.creator)}. Acquire some $creator first (e.g. via /desnet/swap APT→$creator), then retry.`,
        lines,
      };
    }
    // 1% slippage tolerance default.
    const minOut = (out * 99n) / 100n;
    const outLabel = mode === "swap-y2n" ? "NAY" : "YAY";
    lines.push({ kind: "info", text: `Receive ≈ ${formatTokenAmount(out)} ${outLabel}` });
    lines.push({ kind: "info", text: `min_out (1% slip): ${formatTokenAmount(minOut)} ${outLabel}` });
    lines.push({ kind: "info", text: `Tax burn: ${formatTokenAmount(tax)} $creator (spot-equiv basis)` });
    return { ok: true, minOut, lines };
  }

  if (mode === "redeem") {
    if (bal.yay < amountRaw || bal.nay < amountRaw) {
      return {
        ok: false,
        reason: `Need ${formatTokenAmount(amountRaw)} of BOTH YAY and NAY (have YAY: ${formatTokenAmount(bal.yay)}, NAY: ${formatTokenAmount(bal.nay)}).`,
        lines,
      };
    }
    const tax = computeTaxLocal(amountRaw, snap.taxBps);
    const userOut = amountRaw > tax ? amountRaw - tax : 0n;
    if (snap.vault < amountRaw) {
      return {
        ok: false,
        reason: `Vault has ${formatTokenAmount(snap.vault)}, need ${formatTokenAmount(amountRaw)}. (Should never happen if conservation holds.)`,
        lines,
      };
    }
    lines.push({ kind: "info", text: `Burn ${formatTokenAmount(amountRaw)} YAY + ${formatTokenAmount(amountRaw)} NAY` });
    lines.push({ kind: "info", text: `Receive ${formatTokenAmount(userOut)} $creator (after ${formatTokenAmount(tax)} tax skim from vault output)` });
    return { ok: true, lines };
  }

  return { ok: false, reason: "Unknown mode.", lines };
}

// ============ Error decoding ============

function decodeOpinionError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/User rejected|denied|cancel/i.test(msg)) return "Cancelled in wallet.";
  const m = msg.match(/Move abort.*0x[0-9a-fA-F]+::opinion::([A-Z_0-9]+).*?(0x[0-9a-fA-F]+|\d+)/);
  if (m) return `opinion::${m[1]}`;
  // Generic abort + opinion module
  const code = msg.match(/opinion.*?(?:code\s*[:=]\s*|0x)(\d+)/i);
  if (code) return `opinion abort code ${code[1]}`;
  if (/EINSUFFICIENT_BALANCE|coin store empty/i.test(msg)) return "Insufficient balance for this action.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
