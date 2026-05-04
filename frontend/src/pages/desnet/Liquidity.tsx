import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { useFaBalance } from "../../chain/balance";
import { createRpcPool, fromRaw, toRaw } from "../../chain/rpc-pool";
import { DESNET_PACKAGE, TOKENS } from "../../config";
import {
  reserves,
  tokenMetadataAddr,
  lpSupply,
} from "../../chain/desnet/amm";
import {
  handleBytes,
  isHandleRegistered,
  useRegisteredHandles,
  validateHandle,
} from "../../chain/desnet/profile";
import {
  isForeverLocked,
  loadPosition,
  pendingAll,
  type Position,
} from "../../chain/desnet/staking";
import { APT_VIEW, useTokenView } from "../../chain/desnet/tokenIcon";
import { TokenIcon } from "../../components/TokenIcon";
import { PoolStatsPanel } from "../../components/desnet/PoolStatsPanel";
import { normalizeAptosAddr } from "../../chain/desnet/format";

const APT = TOKENS.APT;
const rpc = createRpcPool("desnet-liquidity");

const ADD_LIQUIDITY_FN = `${DESNET_PACKAGE}::lp_staking::add_liquidity`;
const ADD_LIQUIDITY_LOCK_FN = `${DESNET_PACKAGE}::lp_staking::add_liquidity_with_lock`;
const REMOVE_LIQUIDITY_FN = `${DESNET_PACKAGE}::lp_staking::remove_liquidity`;
const CLAIM_FN = `${DESNET_PACKAGE}::lp_staking::claim`;

const HANDLE_DEBOUNCE_MS = 350;

// Frontend tracks position addrs the user creates in this browser. Survives
// page reloads. Pasted-position addrs (e.g. created from another device) are
// also added here. Source of truth is on-chain — we only use this to know
// WHAT to load.
const KEY_FOR_HANDLE = (h: string, owner: string) => `desnet.lp.${owner}.${h}`;

function readKnownPositions(handle: string, owner: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY_FOR_HANDLE(handle, owner));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function rememberPosition(handle: string, owner: string, addr: string): void {
  const existing = readKnownPositions(handle, owner);
  if (existing.includes(addr)) return;
  existing.push(addr);
  localStorage.setItem(KEY_FOR_HANDLE(handle, owner), JSON.stringify(existing));
}

export function Liquidity() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();
  const [searchParams] = useSearchParams();

  // Pre-fill handle (`?h=`) and lock kind (`?lock=free|timed|forever`) from
  // the URL — drives deep-links from Profile and other pages.
  const initialHandle = searchParams.get("h")?.toLowerCase().trim() || "desnet";
  const initialLockRaw = searchParams.get("lock");
  const initialLock: "free" | "timed" | "forever" =
    initialLockRaw === "timed" || initialLockRaw === "forever" ? initialLockRaw : "free";

  const [handle, setHandle] = useState(initialHandle);
  const [resolvedHandle, setResolvedHandle] = useState<string | null>(null);
  const [tokenMeta, setTokenMeta] = useState<string | null>(null);
  const [poolReserves, setPoolReserves] = useState<{ apt: bigint; token: bigint } | null>(null);
  const [poolLpSupply, setPoolLpSupply] = useState<bigint>(0n);

  const [aptIn, setAptIn] = useState("");
  const [tokenIn, setTokenIn] = useState("");
  const [lockKind, setLockKind] = useState<"free" | "timed" | "forever">(initialLock);
  const [lockDays, setLockDays] = useState("30");

  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [positions, setPositions] = useState<
    { meta: Position; pending: [bigint, bigint, bigint] }[]
  >([]);
  const [pasteAddr, setPasteAddr] = useState("");

  const aptBal = useFaBalance(APT.meta, APT.decimals);
  const tokenBal = useFaBalance(tokenMeta, 8);
  const tokenView = useTokenView(tokenMeta);
  const registeredHandles = useRegisteredHandles();

  const handleErr = useMemo(() => (handle ? validateHandle(handle) : null), [handle]);

  // Resolve handle → reserves + token metadata (debounced)
  useEffect(() => {
    setResolvedHandle(null);
    setTokenMeta(null);
    setPoolReserves(null);
    if (!handle || handleErr) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const taken = await isHandleRegistered(rpc, handle);
        if (!taken) {
          if (!cancelled) setError(`@${handle} is not registered`);
          return;
        }
        const meta = await tokenMetadataAddr(rpc, handle);
        const [aR, tR] = await reserves(rpc, handle);
        const lp = await lpSupply(rpc, handle);
        if (cancelled) return;
        setTokenMeta(meta);
        setResolvedHandle(handle);
        setPoolReserves({ apt: aR, token: tR });
        setPoolLpSupply(lp);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    }, HANDLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, handleErr]);

  // Reload all known positions for the connected wallet on this handle.
  useEffect(() => {
    setPositions([]);
    if (!address || !resolvedHandle) return;
    let cancelled = false;
    const known = readKnownPositions(resolvedHandle, address);
    Promise.all(
      known.map(async (addr) => {
        const meta = await loadPosition(rpc, addr);
        if (!meta) return null;
        const pending = await pendingAll(rpc, addr);
        return { meta, pending };
      }),
    ).then((out) => {
      if (cancelled) return;
      setPositions(out.filter((x): x is { meta: Position; pending: [bigint, bigint, bigint] } => !!x));
    });
    return () => {
      cancelled = true;
    };
  }, [address, resolvedHandle, lastTx]);

  // Pair-ratio auto-fill: if user types APT and pool is seeded, suggest the
  // matched token amount at current spot ratio.
  function onAptIn(v: string) {
    setAptIn(v);
    const n = Number(v);
    if (poolReserves && poolReserves.apt > 0n && n > 0) {
      const aptRaw = toRaw(n, APT.decimals);
      const tokenRaw = (aptRaw * poolReserves.token) / poolReserves.apt;
      setTokenIn(fromRaw(tokenRaw, 8).toFixed(6));
    }
  }

  function onTokenIn(v: string) {
    setTokenIn(v);
    const n = Number(v);
    if (poolReserves && poolReserves.token > 0n && n > 0) {
      const tokenRaw = toRaw(n, 8);
      const aptRaw = (tokenRaw * poolReserves.apt) / poolReserves.token;
      setAptIn(fromRaw(aptRaw, APT.decimals).toFixed(6));
    }
  }

  const aptInRaw = useMemo(() => {
    const n = Number(aptIn);
    return Number.isFinite(n) && n > 0 ? toRaw(n, APT.decimals) : 0n;
  }, [aptIn]);
  const tokenInRaw = useMemo(() => {
    const n = Number(tokenIn);
    return Number.isFinite(n) && n > 0 ? toRaw(n, 8) : 0n;
  }, [tokenIn]);

  const expectedShares = useMemo(() => {
    if (poolReserves && poolReserves.apt > 0n && poolLpSupply > 0n) {
      const fromApt = (aptInRaw * poolLpSupply) / poolReserves.apt;
      const fromToken =
        poolReserves.token > 0n ? (tokenInRaw * poolLpSupply) / poolReserves.token : 0n;
      // CPMM mints the smaller of the two — defensive against unbalanced add.
      return fromApt < fromToken ? fromApt : fromToken;
    }
    return 0n;
  }, [poolReserves, poolLpSupply, aptInRaw, tokenInRaw]);

  // 1% slippage on min_lp_out — close enough for the deposit path.
  const minLpOut = (expectedShares * 99n) / 100n;

  const insufficient = aptBal.raw < aptInRaw || tokenBal.raw < tokenInRaw;
  const canAdd =
    !!address &&
    !!resolvedHandle &&
    aptInRaw > 0n &&
    tokenInRaw > 0n &&
    !insufficient &&
    !submitting;

  async function addLiquidity() {
    if (!resolvedHandle || !address) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const nowSecs = Math.floor(Date.now() / 1000);
      let result: { hash: string };
      if (lockKind === "free") {
        result = await signAndSubmitTransaction({
          data: {
            function: ADD_LIQUIDITY_FN,
            typeArguments: [],
            functionArguments: [
              handleBytes(resolvedHandle),
              aptInRaw.toString(),
              tokenInRaw.toString(),
              minLpOut.toString(),
            ],
          },
        });
      } else {
        const days = Number(lockDays);
        const unlockSecs =
          lockKind === "forever" ? "18446744073709551615" : (nowSecs + days * 86400).toString();
        result = await signAndSubmitTransaction({
          data: {
            function: ADD_LIQUIDITY_LOCK_FN,
            typeArguments: [],
            functionArguments: [
              handleBytes(resolvedHandle),
              aptInRaw.toString(),
              tokenInRaw.toString(),
              minLpOut.toString(),
              unlockSecs,
            ],
          },
        });
      }
      setLastTx(result.hash);
      setAptIn("");
      setTokenIn("");
      aptBal.refresh();
      tokenBal.refresh();

      // Pull position addr off the PositionCreated event so we can show it.
      // Routed through the rpc pool's primary client so we benefit from the
      // Geomi auth header + the same fallback ladder the rest of the page uses.
      try {
        await rpc.primary.waitForTransaction({ transactionHash: result.hash });
        const tx = await rpc.primary.transaction.getTransactionByHash({
          transactionHash: result.hash,
        });
        const events = (tx as { events?: Array<{ type: string; data: { position_addr?: string } }> }).events ?? [];
        const ev = events.find((e) => e.type.endsWith("::lp_staking::PositionCreated"));
        const posAddr = ev?.data?.position_addr;
        if (posAddr) {
          rememberPosition(resolvedHandle, address, posAddr);
        } else {
          // Tx confirmed but event missing — surface to user so they can paste manually.
          setError(
            "Position created on chain but its address wasn't returned in events. " +
              "Open the tx on the explorer and paste the position address into 'Import a position'.",
          );
        }
      } catch (e) {
        setError(`Tx submitted but couldn't read PositionCreated event: ${(e as Error).message}. Position is on chain — paste its address from explorer.`);
      }
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function claim(positionAddr: string) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: CLAIM_FN,
          typeArguments: [],
          functionArguments: [positionAddr],
        },
      });
      setLastTx(result.hash);
      tokenBal.refresh();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeLiquidity(positionAddr: string) {
    setSubmitting(true);
    setError(null);
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: REMOVE_LIQUIDITY_FN,
          typeArguments: [],
          functionArguments: [positionAddr, "0", "0"],
        },
      });
      setLastTx(result.hash);
      aptBal.refresh();
      tokenBal.refresh();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function importPasteAddr() {
    if (!resolvedHandle || !address || !pasteAddr.trim()) return;
    setError(null);
    let canonical: string;
    try {
      canonical = normalizeAptosAddr(pasteAddr.trim());
    } catch {
      setError(
        `"${pasteAddr.trim()}" isn't a valid Aptos address. Expected 0x + up to 64 hex chars.`,
      );
      return;
    }
    rememberPosition(resolvedHandle, address, canonical);
    setPasteAddr("");
    setLastTx(lastTx ?? "imported"); // trigger position reload
  }

  return (
    <div className="card">
      <h2>Liquidity · Lock · Stake</h2>
      <p className="muted">
        Add APT + $TOKEN to the pool. Free positions earn LP fees + emission and
        can be removed any time. Locked positions trade liquidity for higher
        commitment signaling — forever-locked positions also count for governance
        weight via <code>voter_history</code>.
      </p>

      <label className="field">
        <span>Handle</span>
        <input
          list="desnet-registered-handles"
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase().trim())}
          placeholder="desnet"
        />
        <datalist id="desnet-registered-handles">
          {registeredHandles.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        {handleErr && <small className="error">{handleErr}</small>}
        {registeredHandles.length > 0 && (
          <small className="muted">
            {registeredHandles.length} handle{registeredHandles.length === 1 ? "" : "s"} registered. Click the field for suggestions.
          </small>
        )}
      </label>

      <PoolStatsPanel
        handle={resolvedHandle}
        tokenMeta={tokenMeta}
        tokenSymbol={resolvedHandle?.toUpperCase() ?? "TOKEN"}
        poolReserves={poolReserves}
      />

      <h3>Add liquidity</h3>
      <label className="field">
        <span>
          <TokenIcon token={APT_VIEW} size={14} /> APT
        </span>
        <input
          type="number"
          inputMode="decimal"
          value={aptIn}
          onChange={(e) => onAptIn(e.target.value)}
          placeholder="0.0"
          min="0"
          step="any"
        />
        <button
          type="button"
          className="bal-link"
          onClick={() => aptBal.raw > 0n && onAptIn(aptBal.formatted.toString())}
          disabled={aptBal.raw === 0n}
        >
          balance: {aptBal.formatted.toLocaleString()} (click for max)
        </button>
      </label>
      <label className="field">
        <span>
          <TokenIcon token={tokenView} size={14} /> $
          {resolvedHandle?.toUpperCase() ?? "TOKEN"}
        </span>
        <input
          type="number"
          inputMode="decimal"
          value={tokenIn}
          onChange={(e) => onTokenIn(e.target.value)}
          placeholder="0.0"
          min="0"
          step="any"
        />
        <button
          type="button"
          className="bal-link"
          onClick={() => tokenBal.raw > 0n && onTokenIn(tokenBal.formatted.toString())}
          disabled={tokenBal.raw === 0n}
        >
          balance: {tokenBal.formatted.toLocaleString()} (click for max)
        </button>
      </label>

      <fieldset className="lock-pick">
        <legend>Position type</legend>
        <label>
          <input
            type="radio"
            checked={lockKind === "free"}
            onChange={() => setLockKind("free")}
          />{" "}
          Free (removable any time)
        </label>
        <label>
          <input
            type="radio"
            checked={lockKind === "timed"}
            onChange={() => setLockKind("timed")}
          />{" "}
          Timed lock —{" "}
          <input
            className="inline-num"
            type="number"
            value={lockDays}
            onChange={(e) => setLockDays(e.target.value)}
            min="1"
            disabled={lockKind !== "timed"}
          />{" "}
          days
        </label>
        <label>
          <input
            type="radio"
            checked={lockKind === "forever"}
            onChange={() => setLockKind("forever")}
          />{" "}
          Forever-lock (counts for governance)
        </label>
      </fieldset>

      <div className="card-stat">
        <div>Expected LP shares</div>
        <div>{expectedShares > 0n ? expectedShares.toString() : "—"}</div>
      </div>

      {!address ? (
        <p className="muted">Connect a wallet to add liquidity.</p>
      ) : insufficient && (aptInRaw > 0n || tokenInRaw > 0n) ? (
        <p className="error">Insufficient balance.</p>
      ) : null}

      <button className="primary" disabled={!canAdd} onClick={addLiquidity}>
        {submitting
          ? lockKind === "forever"
            ? "Staking…"
            : "Adding…"
          : lockKind === "forever"
            ? "Stake (forever-lock + voting power)"
            : lockKind === "timed"
              ? `Add & lock for ${lockDays} days`
              : "Add liquidity"}
      </button>

      <h3>Your positions</h3>
      {positions.length === 0 ? (
        <p className="muted">
          No positions tracked for @{resolvedHandle ?? "…"}. New positions you
          create here are remembered automatically. Have one from another device?
          Paste its address.
        </p>
      ) : (
        <div className="position-list">
          {positions.map(({ meta, pending }) => {
            const [emission, feeApt, feeTok] = pending;
            const locked = isForeverLocked(meta.unlockAtSecs);
            const canRemove =
              !locked && meta.unlockAtSecs <= Math.floor(Date.now() / 1000);
            return (
              <div key={meta.positionAddr} className="position-row">
                <div>
                  <div className="mono small">{meta.positionAddr}</div>
                  <div className="muted small">
                    Shares {meta.shares.toString()} ·{" "}
                    {locked
                      ? "forever-locked"
                      : meta.unlockAtSecs > 0
                      ? `unlocks ${new Date(meta.unlockAtSecs * 1000).toISOString().slice(0, 10)}`
                      : "free"}
                  </div>
                  <div className="muted small">
                    Pending:{" "}
                    {fromRaw(emission, 8).toFixed(6)} ${resolvedHandle?.toUpperCase()}{" "}
                    + {fromRaw(feeApt, 8).toFixed(6)} APT +{" "}
                    {fromRaw(feeTok, 8).toFixed(6)} ${resolvedHandle?.toUpperCase()}
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="link"
                    onClick={() => claim(meta.positionAddr)}
                    disabled={submitting}
                  >
                    claim
                  </button>
                  {canRemove && (
                    <button
                      className="link"
                      onClick={() => removeLiquidity(meta.positionAddr)}
                      disabled={submitting}
                    >
                      remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <details>
        <summary>Import a position by address</summary>
        <div className="grid-2">
          <input
            value={pasteAddr}
            onChange={(e) => setPasteAddr(e.target.value)}
            placeholder="0x… (Position Object addr)"
          />
          <button onClick={importPasteAddr} disabled={!pasteAddr.trim()}>
            Track
          </button>
        </div>
      </details>

      {lastTx && lastTx !== "imported" && (
        <p className="ok">
          Sent. Tx{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
