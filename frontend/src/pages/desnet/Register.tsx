import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { useFaBalance } from "../../chain/balance";
import { createRpcPool, fromRaw } from "../../chain/rpc-pool";
import { TOKENS, DESNET_PACKAGE } from "../../config";
import {
  handleBytes,
  handleFeeOctas,
  handleOfWallet,
  isHandleRegistered,
  totalRegisterCostOctas,
  validateHandle,
} from "../../chain/desnet/profile";

const APT = TOKENS.APT;
const rpc = createRpcPool("desnet-register");

const HANDLE_DEBOUNCE_MS = 350;

const REGISTER_FN = `${DESNET_PACKAGE}::profile::register_handle`;

export function Register() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();
  const aptBal = useFaBalance(APT.meta, APT.decimals);

  const [handle, setHandle] = useState("");
  const [bio, setBio] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [tokenIconUri, setTokenIconUri] = useState("");
  const [tokenProjectUri, setTokenProjectUri] = useState("");
  const [avatarBytes, setAvatarBytes] = useState<Uint8Array | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarErr, setAvatarErr] = useState<string | null>(null);

  const [registered, setRegistered] = useState<string | null | undefined>(undefined);
  const [taken, setTaken] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleErr = useMemo(() => (handle ? validateHandle(handle) : null), [handle]);
  const feeOctas = useMemo(() => handleFeeOctas(handle), [handle]);
  const totalOctas = useMemo(() => totalRegisterCostOctas(handle), [handle]);

  // Detect existing registration on connect — short-circuit the wizard.
  useEffect(() => {
    let cancelled = false;
    if (!address) {
      setRegistered(undefined);
      return;
    }
    setRegistered(undefined);
    handleOfWallet(rpc, address).then((h) => {
      if (!cancelled) setRegistered(h);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Live taken-ness probe (debounced).
  useEffect(() => {
    setTaken(null);
    if (!handle || handleErr) return;
    let cancelled = false;
    const t = setTimeout(() => {
      isHandleRegistered(rpc, handle).then((b) => {
        if (!cancelled) setTaken(b);
      });
    }, HANDLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, handleErr]);

  function onPickAvatar(file: File | null) {
    setAvatarErr(null);
    if (!file) {
      setAvatarBytes(null);
      setAvatarPreview(null);
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const result = String(fr.result ?? "");
      // On-chain layout: profile.move::Profile.avatar_blob_id is a
      // vector<u8> capped at AVATAR_MAX_BYTES (8 KB). We store the base64
      // payload bytes WITHOUT the `data:image/...;base64,` header — readers
      // sniff MIME from the leading bytes via guessMimeFromB64() and rebuild
      // the data: URL on display. 8 KB cap applies to the BASE64 byte length,
      // not the original image bytes (base64 is ~4/3 the size of raw).
      const commaIdx = result.indexOf(",");
      const b64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      const bytes = new TextEncoder().encode(b64);
      if (bytes.length > 8 * 1024) {
        setAvatarErr(`Avatar too large after base64 (${(bytes.length / 1024).toFixed(1)} KB > 8 KB). Use a smaller image.`);
        setAvatarBytes(null);
        setAvatarPreview(null);
        return;
      }
      setAvatarBytes(bytes);
      setAvatarPreview(result);
    };
    fr.readAsDataURL(file);
  }

  const insufficient = aptBal.raw < totalOctas;
  const canSubmit =
    !!address &&
    !!handle &&
    !handleErr &&
    taken === false &&
    !!tokenName &&
    !!tokenSymbol &&
    !insufficient &&
    !submitting &&
    registered === null;

  async function submit() {
    if (!address) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const result = await signAndSubmitTransaction({
        data: {
          function: REGISTER_FN,
          typeArguments: [],
          functionArguments: [
            handleBytes(handle),
            address, // controller_addr — default to caller's wallet
            avatarBytes ? Array.from(avatarBytes) : [],
            Array.from(new TextEncoder().encode(bio)),
            Array.from(new TextEncoder().encode(tokenName)),
            Array.from(new TextEncoder().encode(tokenSymbol)),
            Array.from(new TextEncoder().encode(tokenIconUri)),
            Array.from(new TextEncoder().encode(tokenProjectUri)),
          ],
        },
      });
      setLastTx(result.hash);
      aptBal.refresh();
      // Refresh the registered-detection so the success card shows.
      const h = await handleOfWallet(rpc, address);
      setRegistered(h);
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (registered === undefined) {
    return <div className="page-loading">Checking your wallet…</div>;
  }

  if (registered) {
    return (
      <div className="card">
        <h2>Already registered</h2>
        <p>
          Your wallet holds the PID for <strong>@{registered}</strong>.
        </p>
        <p>
          Visit your profile at{" "}
          <a href={`/desnet/p/${registered}`}>/desnet/p/{registered}</a> to mint,
          configure your token, or view your feed.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Register a handle</h2>
      <p className="muted">
        Atomic on-chain registration: mints your PID Object NFT, spawns
        <code> $YOUR_TOKEN</code> (1B supply), seeds an APT/$TOKEN AMM pool with 5
        APT + 50M tokens, and forever-locks your creator LP position. Handle is
        immutable once registered.
      </p>

      <label className="field">
        <span>Handle</span>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase())}
          placeholder="alice"
          maxLength={64}
          autoFocus
        />
        <small>
          {handleErr ? (
            <span className="error">{handleErr}</span>
          ) : taken === true ? (
            <span className="error">@{handle} is taken</span>
          ) : taken === false ? (
            <span className="ok">@{handle} is available</span>
          ) : (
            "lower-case a-z, digits, underscore. Must start with a letter."
          )}
        </small>
      </label>

      <div className="grid-2">
        <label className="field">
          <span>Token name</span>
          <input
            value={tokenName}
            onChange={(e) => setTokenName(e.target.value)}
            placeholder={handle ? handle.toUpperCase() + " Token" : "Alice Token"}
          />
        </label>
        <label className="field">
          <span>Token symbol</span>
          <input
            value={tokenSymbol}
            onChange={(e) => setTokenSymbol(e.target.value.toUpperCase())}
            placeholder={handle ? handle.toUpperCase() : "ALICE"}
            maxLength={10}
          />
        </label>
      </div>

      <label className="field">
        <span>Bio</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="Optional — ≤333 bytes, plain text."
          maxLength={333}
          rows={2}
        />
        <small>{new TextEncoder().encode(bio).length} / 333 bytes</small>
      </label>

      <label className="field">
        <span>Avatar (≤8 KB after base64)</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          onChange={(e) => onPickAvatar(e.target.files?.[0] ?? null)}
        />
        {avatarErr && <small className="error">{avatarErr}</small>}
        {avatarPreview && (
          <img
            src={avatarPreview}
            alt="avatar preview"
            style={{ width: 80, height: 80, borderRadius: 8, marginTop: 8, objectFit: "cover" }}
          />
        )}
      </label>

      <details>
        <summary>Token icon + project URI (optional)</summary>
        <label className="field">
          <span>Icon URI</span>
          <input
            value={tokenIconUri}
            onChange={(e) => setTokenIconUri(e.target.value)}
            placeholder="https://… (used by wallets to render the token icon)"
          />
        </label>
        <label className="field">
          <span>Project URI</span>
          <input
            value={tokenProjectUri}
            onChange={(e) => setTokenProjectUri(e.target.value)}
            placeholder="https://your-project.example"
          />
        </label>
      </details>

      <div className="card-stat">
        <div>Handle fee</div>
        <div>
          <strong>{fromRaw(feeOctas, APT.decimals).toLocaleString()}</strong> APT
        </div>
      </div>
      <div className="card-stat">
        <div>Pool seed (5 APT, paired with 50M tokens)</div>
        <div><strong>5</strong> APT</div>
      </div>
      <div className="card-stat">
        <div>Total now</div>
        <div>
          <strong>{fromRaw(totalOctas, APT.decimals).toLocaleString()}</strong> APT
        </div>
      </div>
      <div className="card-stat">
        <div>Your APT balance</div>
        <div>{aptBal.formatted.toLocaleString()} APT</div>
      </div>

      <p className="muted small">
        Of the handle fee: 10% routes to the deployer multisig, 90% goes through
        the on-chain APT→DESNET buyback-burn (see About).
      </p>

      {!address ? (
        <p className="muted">Connect a wallet to continue.</p>
      ) : insufficient ? (
        <p className="error">
          Insufficient APT. Need {fromRaw(totalOctas, APT.decimals).toLocaleString()},
          have {aptBal.formatted.toLocaleString()}.
        </p>
      ) : null}

      <button className="primary" disabled={!canSubmit} onClick={submit}>
        {submitting ? "Registering…" : `Register @${handle || "…"}`}
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
