import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { useFaBalance } from "../../chain/balance";
import { createRpcPool, fromRaw, toRaw } from "../../chain/rpc-pool";
import { DESNET_PACKAGE, SLIPPAGE, TOKENS } from "../../config";
import {
  computeAmountOut,
  reserves,
  tokenMetadataAddr,
} from "../../chain/desnet/amm";
import {
  handleBytes,
  isHandleRegistered,
  validateHandle,
} from "../../chain/desnet/profile";
import { APT_VIEW, useTokenView } from "../../chain/desnet/tokenIcon";
import { TokenIcon } from "../../components/TokenIcon";
import { formatNumberForInput } from "../../chain/desnet/format";

const APT = TOKENS.APT;
const rpc = createRpcPool("desnet-swap");

const SWAP_APT_FOR_TOKEN_FN = `${DESNET_PACKAGE}::amm::swap_apt_for_token`;
const SWAP_TOKEN_FOR_APT_FN = `${DESNET_PACKAGE}::amm::swap_token_for_apt`;

const HANDLE_DEBOUNCE_MS = 350;

export function Swap() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [handle, setHandle] = useState("desnet");
  const [resolvedHandle, setResolvedHandle] = useState<string | null>("desnet");
  const [tokenMeta, setTokenMeta] = useState<string | null>(null);
  const [tokenSymbol, setTokenSymbol] = useState<string>("DESNET");
  const [poolReserves, setPoolReserves] = useState<{ apt: bigint; token: bigint } | null>(null);

  const [aptToToken, setAptToToken] = useState(true);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aptBal = useFaBalance(APT.meta, APT.decimals);
  const tokenBal = useFaBalance(tokenMeta, 8);
  const tokenView = useTokenView(tokenMeta);

  const handleErr = useMemo(() => (handle ? validateHandle(handle) : null), [handle]);

  // Resolve handle → tokenMeta + reserves whenever the handle stabilises.
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
        if (cancelled) return;
        setTokenMeta(meta);
        setTokenSymbol(handle.toUpperCase());
        setResolvedHandle(handle);
        setError(null);
        const [aR, tR] = await reserves(rpc, handle);
        if (!cancelled) setPoolReserves({ apt: aR, token: tR });
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    }, HANDLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, handleErr]);

  const amountInRaw = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return toRaw(n, 8); // both sides use 8 decimals
  }, [amount]);

  const amountOutRaw = useMemo(() => {
    if (!poolReserves || amountInRaw <= 0n) return 0n;
    if (aptToToken) return computeAmountOut(poolReserves.apt, poolReserves.token, amountInRaw);
    return computeAmountOut(poolReserves.token, poolReserves.apt, amountInRaw);
  }, [poolReserves, amountInRaw, aptToToken]);

  const minOutRaw = useMemo(() => {
    if (amountOutRaw <= 0n) return 0n;
    const denom = 10_000n;
    const slip = BigInt(Math.round(SLIPPAGE * Number(denom)));
    return (amountOutRaw * (denom - slip)) / denom;
  }, [amountOutRaw]);

  const fromBal = aptToToken ? aptBal : tokenBal;
  const insufficient = fromBal.raw < amountInRaw;

  async function submit() {
    if (!resolvedHandle || amountInRaw <= 0n) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const fn = aptToToken ? SWAP_APT_FOR_TOKEN_FN : SWAP_TOKEN_FOR_APT_FN;
      const result = await signAndSubmitTransaction({
        data: {
          function: fn,
          typeArguments: [],
          functionArguments: [
            handleBytes(resolvedHandle),
            amountInRaw.toString(),
            minOutRaw.toString(),
          ],
        },
      });
      setLastTx(result.hash);
      setAmount("");
      aptBal.refresh();
      tokenBal.refresh();
      // Re-fetch reserves so the next quote reflects post-swap state.
      const [aR, tR] = await reserves(rpc, resolvedHandle);
      setPoolReserves({ apt: aR, token: tR });
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !!address && !!resolvedHandle && amountInRaw > 0n && !insufficient && !submitting;

  return (
    <div className="card">
      <h2>Swap APT ↔ $TOKEN</h2>
      <p className="muted">
        10 bps fee, 100% to LP. Each handle has its own pool — type a handle to
        load reserves.
      </p>

      <label className="field">
        <span>Token (DeSNet handle)</span>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase().trim())}
          placeholder="desnet"
        />
        {handleErr && <small className="error">{handleErr}</small>}
      </label>

      <div className="card-stat">
        <div>Pool reserves</div>
        <div>
          {poolReserves ? (
            <>
              <strong>{fromRaw(poolReserves.apt, 8).toLocaleString()}</strong> APT ·{" "}
              <strong>{fromRaw(poolReserves.token, 8).toLocaleString()}</strong>{" "}
              ${tokenSymbol}
            </>
          ) : (
            "—"
          )}
        </div>
      </div>

      <div className="swap-side">
        <div className="swap-row">
          <label className="field">
            <span>From</span>
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              min="0"
              step="any"
            />
          </label>
          <div className="swap-token">
            <TokenIcon
              token={aptToToken ? APT_VIEW : tokenView}
              size={18}
            />{" "}
            {aptToToken ? "APT" : `$${tokenSymbol}`}
            <button
              className="link"
              onClick={() => setAmount(formatNumberForInput(fromBal.formatted))}
              type="button"
            >
              max ({fromBal.formatted.toLocaleString()})
            </button>
          </div>
        </div>

        <button
          className="link flip"
          type="button"
          onClick={() => setAptToToken((v) => !v)}
          aria-label="Flip swap direction"
        >
          ↕ flip
        </button>

        <div className="swap-row">
          <label className="field">
            <span>To (estimated)</span>
            <input
              type="text"
              readOnly
              value={amountOutRaw > 0n ? fromRaw(amountOutRaw, 8).toFixed(6) : ""}
            />
          </label>
          <div className="swap-token">
            <TokenIcon
              token={aptToToken ? tokenView : APT_VIEW}
              size={18}
            />{" "}
            {aptToToken ? `$${tokenSymbol}` : "APT"}
          </div>
        </div>
      </div>

      <div className="card-stat">
        <div>Min received ({(SLIPPAGE * 100).toFixed(2)}% slippage)</div>
        <div>{minOutRaw > 0n ? fromRaw(minOutRaw, 8).toFixed(6) : "—"}</div>
      </div>

      {!address ? (
        <p className="muted">Connect a wallet to swap.</p>
      ) : insufficient && amountInRaw > 0n ? (
        <p className="error">Insufficient balance.</p>
      ) : null}

      <button className="primary" disabled={!canSubmit} onClick={submit}>
        {submitting ? "Swapping…" : "Swap"}
      </button>

      {lastTx && (
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
