import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { createRpcPool, fromRaw } from "../../chain/rpc-pool";
import { DESNET_PACKAGE } from "../../config";
import {
  handleToWallet,
  loadProfileResource,
  deriveProfileAddress,
  type ProfileMeta,
} from "../../chain/desnet/profile";
import { mintCount } from "../../chain/desnet/mint";
import { isSynced, syncCount, syncedByCount, syncArgs, unsyncArgs, SYNC_FN, UNSYNC_FN } from "../../chain/desnet/link";
import { reserves, lpSupply, tokenMetadataAddr } from "../../chain/desnet/amm";
import { useTokenView } from "../../chain/desnet/tokenIcon";
import { TokenIcon } from "../../components/TokenIcon";
import {
  aptosAddrEq,
  guessMimeFromB64,
  safeImageDataUrl,
  shortAddr,
} from "../../chain/desnet/format";

const rpc = createRpcPool("desnet-profile");

const APT_DECIMALS = 8;
const TOKEN_DECIMALS = 8;

type Snapshot = {
  pidAddr: string;
  wallet: string;
  profile: ProfileMeta;
  mintCount: number;
  syncCount: number;
  syncedByCount: number;
  pool: { aptReserve: bigint; tokenReserve: bigint; lpSupply: bigint } | null;
  tokenMeta: string | null;
};

export function Profile() {
  const { handle } = useParams<{ handle: string }>();
  const myAddr = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [iSync, setISync] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setSnap(null);
    setISync(null);

    (async () => {
      if (!handle) return;
      const wallet = await handleToWallet(rpc, handle);
      if (!wallet) {
        if (!cancelled) {
          setNotFound(true);
          setLoading(false);
        }
        return;
      }
      const pidAddr = await deriveProfileAddress(rpc, wallet);
      const [profile, mc, sc, sbc, tokenMeta] = await Promise.all([
        loadProfileResource(rpc, pidAddr),
        mintCount(rpc, pidAddr).catch(() => 0),
        syncCount(rpc, pidAddr),
        syncedByCount(rpc, pidAddr),
        tokenMetadataAddr(rpc, handle).catch(() => null),
      ]);
      let pool: Snapshot["pool"] = null;
      try {
        const [a, t] = await reserves(rpc, handle);
        const lp = await lpSupply(rpc, handle);
        pool = { aptReserve: a, tokenReserve: t, lpSupply: lp };
      } catch {
        pool = null;
      }
      if (cancelled) return;
      if (!profile) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      setSnap({
        pidAddr,
        wallet,
        profile,
        mintCount: mc,
        syncCount: sc,
        syncedByCount: sbc,
        pool,
        tokenMeta,
      });
      setLoading(false);
    })().catch((e) => {
      if (cancelled) return;
      setError((e as Error).message ?? String(e));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [handle, lastTx, refreshTick]);

  // Probe whether the connected wallet syncs to this PID — drives the
  // Sync/Unsync button state.
  useEffect(() => {
    let cancelled = false;
    if (!myAddr || !snap) {
      setISync(null);
      return;
    }
    deriveProfileAddress(rpc, myAddr)
      .then((myPid) => isSynced(rpc, myPid, snap.pidAddr))
      .then((b) => {
        if (!cancelled) setISync(b);
      })
      .catch(() => {
        if (!cancelled) setISync(null);
      });
    return () => {
      cancelled = true;
    };
  }, [myAddr, snap]);

  async function toggleSync() {
    if (!snap || !myAddr) return;
    setBusy(true);
    setError(null);
    try {
      const fn = iSync ? UNSYNC_FN : SYNC_FN;
      const args = iSync ? unsyncArgs(snap.pidAddr) : syncArgs(snap.pidAddr);
      const result = await signAndSubmitTransaction({
        data: { function: fn, typeArguments: [], functionArguments: args },
      });
      setLastTx(result.hash);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  // Hook order is fixed regardless of branch — call before early returns.
  const tokenView = useTokenView(snap?.tokenMeta ?? null);

  if (loading) return <div className="page-loading">Loading @{handle}…</div>;
  if (notFound) {
    return (
      <div className="card">
        <h2>@{handle} not found</h2>
        <p className="muted">
          This handle isn't registered. <a href="/desnet/register">Claim it →</a>
        </p>
      </div>
    );
  }
  if (!snap) return null;

  // Avatar bytes are stored as base64. Sniff MIME from leading bytes,
  // sanitize SVG (defense-in-depth — img-tag is sandboxed but still),
  // returns null if MIME is unrecognized → fall back to letter avatar.
  const avatarSrc = snap.profile.avatarBase64
    ? safeImageDataUrl(snap.profile.avatarBase64, guessMimeFromB64(snap.profile.avatarBase64))
    : null;

  const isMe = !!myAddr && aptosAddrEq(myAddr, snap.wallet);

  // Spot price = APT reserve / token reserve (in display units)
  const spotPrice =
    snap.pool && snap.pool.tokenReserve > 0n
      ? fromRaw(snap.pool.aptReserve, APT_DECIMALS) /
        fromRaw(snap.pool.tokenReserve, TOKEN_DECIMALS)
      : null;

  return (
    <>
      <div className="card profile-card">
        <div className="profile-head">
          {avatarSrc && !avatarFailed ? (
            <img
              src={avatarSrc}
              alt={`${snap.profile.handle} avatar`}
              className="avatar"
              onError={() => setAvatarFailed(true)}
            />
          ) : (
            <div className="avatar avatar-fallback">{snap.profile.handle[0]?.toUpperCase()}</div>
          )}
          <div className="profile-meta">
            <h2>@{snap.profile.handle}</h2>
            <div className="muted small">
              wallet <code>{shortAddr(snap.wallet)}</code> · pid{" "}
              <code>{shortAddr(snap.pidAddr)}</code>
            </div>
            {snap.profile.bio && <p className="bio">{snap.profile.bio}</p>}
          </div>
        </div>

        <div className="profile-stats">
          <div><strong>{snap.mintCount}</strong> mints</div>
          <div><strong>{snap.syncCount}</strong> syncing</div>
          <div><strong>{snap.syncedByCount}</strong> synced by</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {!isMe && myAddr && (
            <button
              className="primary"
              onClick={toggleSync}
              disabled={busy || iSync === null}
            >
              {busy ? "…" : iSync ? "Unsync" : "Sync"}
            </button>
          )}
          <button
            className="link small"
            onClick={() => setRefreshTick((t) => t + 1)}
            title="Re-read profile from chain (use after PID transfer or to pull latest stats)"
            disabled={busy}
          >
            ↻ refresh
          </button>
        </div>
        {isMe && <p className="muted small">This is your profile.</p>}
      </div>

      <div className="card">
        <h3>
          <TokenIcon token={tokenView} size={18} /> $
          {snap.profile.handle.toUpperCase()} token
        </h3>
        {snap.pool ? (
          <>
            <div className="card-stat">
              <div>Spot price (APT per ${snap.profile.handle.toUpperCase()})</div>
              <div>{spotPrice != null ? spotPrice.toExponential(4) : "—"}</div>
            </div>
            <div className="card-stat">
              <div>APT reserve</div>
              <div>{fromRaw(snap.pool.aptReserve, APT_DECIMALS).toLocaleString()}</div>
            </div>
            <div className="card-stat">
              <div>${snap.profile.handle.toUpperCase()} reserve</div>
              <div>{fromRaw(snap.pool.tokenReserve, TOKEN_DECIMALS).toLocaleString()}</div>
            </div>
            <div className="card-stat">
              <div>LP supply</div>
              <div>{snap.pool.lpSupply.toString()}</div>
            </div>
            {snap.tokenMeta && (
              <div className="card-stat">
                <div>FA metadata</div>
                <div>
                  <a
                    href={`https://explorer.aptoslabs.com/object/${snap.tokenMeta}?network=mainnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {shortAddr(snap.tokenMeta)}
                  </a>
                </div>
              </div>
            )}
            <p className="muted small">
              Trade on the{" "}
              <a href={`/desnet/swap?h=${snap.profile.handle}`}>Swap tab</a> · Add LP
              on the <a href={`/desnet/liquidity?h=${snap.profile.handle}`}>Liquidity tab</a>.
            </p>
          </>
        ) : (
          <p className="muted">Pool not initialised.</p>
        )}
        <div className="card-stat">
          <div>Package</div>
          <div>
            <a
              href={`https://explorer.aptoslabs.com/account/${DESNET_PACKAGE}/modules/code/profile?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {shortAddr(DESNET_PACKAGE)}
            </a>
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {lastTx && (
        <p className="ok">
          Sent.{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
    </>
  );
}

// shortAddr / guessMimeFromB64 moved to chain/desnet/format.ts
