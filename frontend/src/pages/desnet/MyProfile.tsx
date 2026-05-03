// MyProfile — dashboard for the connected wallet's PID. Shows quick links +
// inline settings card to mutate Profile metadata (bio, avatar, banner,
// metadata_uri). Uses profile::update_metadata which requires controller auth.
//
// If wallet not connected → ConnectButton.
// If wallet connected but no handle → "Register first" CTA.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { createRpcPool } from "../../chain/rpc-pool";
import {
  deriveProfileAddress,
  handleOfWallet,
  loadProfileResource,
  type ProfileMeta,
} from "../../chain/desnet/profile";
import { DESNET_PACKAGE } from "../../config";
import { useAddress } from "../../wallet/useConnect";
import { ConnectButton } from "../../components/ConnectButton";

const rpc = createRpcPool("desnet-myprofile");
const UPDATE_METADATA_FN = `${DESNET_PACKAGE}::profile::update_metadata`;
const AVATAR_MAX_BYTES = 8 * 1024;
const BIO_MAX_BYTES = 333;

export function MyProfile() {
  const myAddr = useAddress();
  const { signAndSubmitTransaction } = useWallet();
  const [handle, setHandle] = useState<string | null>(null);
  const [pidAddr, setPidAddr] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // Resolve wallet → handle + pid + profile resource
  useEffect(() => {
    let cancelled = false;
    if (!myAddr) {
      setHandle(null);
      setPidAddr(null);
      setProfile(null);
      setResolved(false);
      return;
    }
    setLoading(true);
    setResolved(false);
    (async () => {
      try {
        const h = await handleOfWallet(rpc, myAddr);
        if (cancelled) return;
        if (!h || h.length === 0) {
          setHandle(null);
          setResolved(true);
          return;
        }
        setHandle(h);
        const p = await deriveProfileAddress(rpc, myAddr);
        if (cancelled) return;
        setPidAddr(p);
        const meta = await loadProfileResource(rpc, p);
        if (cancelled) return;
        setProfile(meta);
        setResolved(true);
      } catch {
        if (!cancelled) {
          setHandle(null);
          setResolved(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [myAddr, refreshTick]);

  if (!myAddr) {
    return (
      <div className="card">
        <h2>My Profile</h2>
        <p className="muted">Connect a wallet to view + manage your DeSNet profile.</p>
        <ConnectButton />
      </div>
    );
  }

  if (loading || !resolved) {
    return <div className="page-loading">Resolving your handle…</div>;
  }

  if (!handle) {
    return (
      <div className="card">
        <h2>No handle registered</h2>
        <p className="muted">
          Wallet <code>{myAddr.slice(0, 8)}…{myAddr.slice(-4)}</code> has no DeSNet handle yet.
          Register one to claim your timeline + factory token + opinion-mint authority.
        </p>
        <Link to="/desnet/register" className="primary" style={{ display: "inline-block", marginTop: 8 }}>
          Register a handle →
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>@{handle}</h2>
        <p className="muted small">
          PID <code>{pidAddr?.slice(0, 8)}…{pidAddr?.slice(-4)}</code> · controller{" "}
          <code>{myAddr.slice(0, 8)}…{myAddr.slice(-4)}</code>
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <Link to={`/desnet/p/${handle}/post`} className="link">📝 Feed + Compose</Link>
          <Link to={`/desnet/p/${handle}`} className="link">👤 Public profile</Link>
          <Link to="/desnet/swap" className="link">💱 Swap your $TOKEN</Link>
          <Link to="/desnet/portfolio" className="link">📊 Portfolio</Link>
        </div>
      </div>

      {profile && pidAddr && (
        <SettingsCard
          handle={handle}
          pidAddr={pidAddr}
          profile={profile}
          onSubmit={async (newAvatar, newBanner, newBio, newMetaUri) => {
            const result = await signAndSubmitTransaction({
              data: {
                function: UPDATE_METADATA_FN,
                typeArguments: [],
                functionArguments: [
                  pidAddr,
                  Array.from(newAvatar),
                  Array.from(newBanner),
                  Array.from(new TextEncoder().encode(newBio)),
                  Array.from(new TextEncoder().encode(newMetaUri)),
                ],
              },
            });
            return result.hash;
          }}
          onSaved={() => setRefreshTick((t) => t + 1)}
        />
      )}
    </div>
  );
}

function SettingsCard({
  handle,
  profile,
  onSubmit,
  onSaved,
}: {
  handle: string;
  pidAddr: string;
  profile: ProfileMeta;
  onSubmit: (
    avatar: Uint8Array,
    banner: Uint8Array,
    bio: string,
    metaUri: string,
  ) => Promise<string>;
  onSaved: () => void;
}) {
  // Bio + metadata_uri are plain strings
  const [bio, setBio] = useState(profile.bio);
  const [metaUri, setMetaUri] = useState(profile.metadataUri);
  // Avatar/banner: keep current bytes by default; replace by file picker
  const [avatarBytes, setAvatarBytes] = useState<Uint8Array>(
    new TextEncoder().encode(profile.avatarBase64),
  );
  const [avatarPreview, setAvatarPreview] = useState<string | null>(
    profile.avatarBase64 ? `data:image/*;base64,${profile.avatarBase64}` : null,
  );
  const [bannerBytes, setBannerBytes] = useState<Uint8Array>(
    new TextEncoder().encode(profile.bannerBase64),
  );
  const [bannerPreview, setBannerPreview] = useState<string | null>(
    profile.bannerBase64 ? `data:image/*;base64,${profile.bannerBase64}` : null,
  );
  const [pickErr, setPickErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onPickFile(file: File | null, kind: "avatar" | "banner") {
    setPickErr(null);
    if (!file) {
      if (kind === "avatar") {
        setAvatarBytes(new Uint8Array());
        setAvatarPreview(null);
      } else {
        setBannerBytes(new Uint8Array());
        setBannerPreview(null);
      }
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const result = String(fr.result ?? "");
      const commaIdx = result.indexOf(",");
      const b64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      const bytes = new TextEncoder().encode(b64);
      if (bytes.length > AVATAR_MAX_BYTES) {
        setPickErr(
          `${kind} too large after base64 (${(bytes.length / 1024).toFixed(1)} KB > ${AVATAR_MAX_BYTES / 1024} KB).`,
        );
        return;
      }
      if (kind === "avatar") {
        setAvatarBytes(bytes);
        setAvatarPreview(result);
      } else {
        setBannerBytes(bytes);
        setBannerPreview(result);
      }
    };
    fr.readAsDataURL(file);
  }

  function clearImage(kind: "avatar" | "banner") {
    if (kind === "avatar") {
      setAvatarBytes(new Uint8Array());
      setAvatarPreview(null);
    } else {
      setBannerBytes(new Uint8Array());
      setBannerPreview(null);
    }
  }

  const bioBytes = new TextEncoder().encode(bio).length;
  const bioErr = bioBytes > BIO_MAX_BYTES ? `Bio over ${BIO_MAX_BYTES} bytes (${bioBytes})` : null;
  const canSubmit = !bioErr && !pickErr && !submitting;

  async function submit() {
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const hash = await onSubmit(avatarBytes, bannerBytes, bio, metaUri);
      setLastTx(hash);
      onSaved();
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Profile metadata · @{handle}</h3>
      <p className="muted small">
        All fields below are mutable. Calls{" "}
        <code>profile::update_metadata</code> — requires controller signature
        (you, by default).
      </p>

      <label className="field">
        <span>Bio (≤333 bytes)</span>
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={3}
          maxLength={400}
        />
        <small className={bioErr ? "error" : "muted"}>
          {bioBytes} / {BIO_MAX_BYTES} bytes {bioErr && `· ${bioErr}`}
        </small>
      </label>

      <label className="field">
        <span>Avatar (optional · ≤8 KB after base64)</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null, "avatar")}
        />
        {avatarPreview && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <img
              src={avatarPreview}
              alt="avatar"
              style={{ width: 80, height: 80, borderRadius: 8, objectFit: "cover" }}
            />
            <button className="link" onClick={() => clearImage("avatar")}>
              clear
            </button>
          </div>
        )}
      </label>

      <label className="field">
        <span>Banner (optional · ≤8 KB after base64)</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null, "banner")}
        />
        {bannerPreview && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
            <img
              src={bannerPreview}
              alt="banner"
              style={{ width: 200, height: 60, borderRadius: 4, objectFit: "cover" }}
            />
            <button className="link" onClick={() => clearImage("banner")}>
              clear
            </button>
          </div>
        )}
      </label>

      <label className="field">
        <span>Metadata URI (optional)</span>
        <input
          value={metaUri}
          onChange={(e) => setMetaUri(e.target.value)}
          placeholder="https://your-site.example or ipfs://…"
        />
      </label>

      {pickErr && <p className="error small">{pickErr}</p>}

      <button className="primary" disabled={!canSubmit} onClick={submit}>
        {submitting ? "Saving…" : "Save metadata"}
      </button>

      {lastTx && (
        <p className="ok" style={{ marginTop: 8 }}>
          Saved.{" "}
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
