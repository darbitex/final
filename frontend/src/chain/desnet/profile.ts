import { useEffect, useState } from "react";
import type { RpcPool } from "../rpc-pool";
import { DESNET_PACKAGE, DESNET_HANDLE_FEE_OCTAS, DESNET_POOL_SEED_OCTAS } from "../../config";

const MOD = "profile";

export type ProfileMeta = {
  handle: string;
  controller: string;
  metadataUri: string;
  bio: string;
  avatarBase64: string; // empty if not set
  bannerBase64: string;
  registeredAtSecs: number;
  syncGate: boolean; // true if attached
};

// Derive PID Object addr from a wallet — read from chain because the seed
// includes a hash of @desnet that we don't want to reimplement client-side.
export async function deriveProfileAddress(rpc: RpcPool, wallet: string): Promise<string> {
  const r = await rpc.viewFn<[string]>(MOD + "::derive_pid_address", [], [wallet], DESNET_PACKAGE);
  return String(r[0]);
}

export async function profileExists(rpc: RpcPool, pidAddr: string): Promise<boolean> {
  const r = await rpc.viewFn<[boolean]>(MOD + "::profile_exists", [], [pidAddr], DESNET_PACKAGE);
  return Boolean(r[0]);
}

export async function isHandleRegistered(rpc: RpcPool, handle: string): Promise<boolean> {
  const bytes = handleBytes(handle);
  try {
    const r = await rpc.viewFn<[boolean]>(MOD + "::is_registered", [], [bytes], DESNET_PACKAGE);
    return Boolean(r[0]);
  } catch {
    return false;
  }
}

export async function handleToWallet(rpc: RpcPool, handle: string): Promise<string | null> {
  try {
    const r = await rpc.viewFn<[string]>(
      MOD + "::handle_to_wallet",
      [],
      [handleBytes(handle)],
      DESNET_PACKAGE,
    );
    return String(r[0]);
  } catch {
    return null;
  }
}

export async function handleOf(rpc: RpcPool, pidAddr: string): Promise<string | null> {
  try {
    const r = await rpc.viewFn<[string]>(MOD + "::handle_of", [], [pidAddr], DESNET_PACKAGE);
    return String(r[0]);
  } catch {
    return null;
  }
}

// Convenience: wallet → handle (PID derived inside the view).
export async function handleOfWallet(rpc: RpcPool, wallet: string): Promise<string | null> {
  try {
    const r = await rpc.viewFn<[string]>(MOD + "::handle_of_wallet", [], [wallet], DESNET_PACKAGE);
    return String(r[0]);
  } catch {
    return null;
  }
}

export async function controllerOf(rpc: RpcPool, pidAddr: string): Promise<string> {
  const r = await rpc.viewFn<[string]>(MOD + "::controller_of", [], [pidAddr], DESNET_PACKAGE);
  return String(r[0]);
}

// Read the Profile resource directly so we get avatar + banner + bio in one
// round-trip instead of a view per field.
type ProfileResource = {
  handle: string;
  controller: string;
  signers_: unknown;
  metadata_uri: string;
  avatar_blob_id: string; // hex
  banner_blob_id: string;
  bio: string;
  sync_gate: { vec: unknown[] };
  registered_at_secs: string;
};

export async function loadProfileResource(
  rpc: RpcPool,
  pidAddr: string,
): Promise<ProfileMeta | null> {
  try {
    const res = await rpc.rotatedGetResource<ProfileResource>(
      pidAddr,
      `${DESNET_PACKAGE}::${MOD}::Profile`,
    );
    return {
      handle: res.handle,
      controller: res.controller,
      metadataUri: res.metadata_uri,
      bio: res.bio,
      avatarBase64: hexToUtf8(res.avatar_blob_id),
      bannerBase64: hexToUtf8(res.banner_blob_id),
      registeredAtSecs: Number(res.registered_at_secs ?? 0),
      syncGate: Array.isArray(res.sync_gate?.vec) && res.sync_gate.vec.length > 0,
    };
  } catch {
    return null;
  }
}

// ============ Pricing helpers — pure JS (mirrors profile.move::handle_fee_apt) ============

/// APT octas required by `register_handle`: tier price + 5 APT pool seed.
/// Both are withdrawn from primary store as separate FAs in the same tx.
export function totalRegisterCostOctas(handle: string): bigint {
  return handleFeeOctas(handle) + DESNET_POOL_SEED_OCTAS;
}

export function handleFeeOctas(handle: string): bigint {
  const len = utf8ByteLength(handle);
  if (len <= 0) return 0n;
  const tier = len >= 6 ? 6 : len;
  return DESNET_HANDLE_FEE_OCTAS[tier] ?? DESNET_HANDLE_FEE_OCTAS[6];
}

// Module-scoped cache so navigating between pages doesn't re-fetch.
// Refreshes only on full page reload — registered handles is monotonic
// (you can't unregister), so a stale cache only ever underrepresents
// the list.
let cachedHandles: string[] | null = null;
let inflight: Promise<string[]> | null = null;

// Indexer transactions table — `register_handle` calls under the desnet
// factory. Each successful tx with this entry function is a freshly
// registered handle. Filter to `success=true` so we don't pick up
// reverted attempts. The handle string is in the entry's `arguments[0]`
// (vector<u8> as base64) — we hex/base64 decode in JS below.
const REGISTER_HANDLE_FN = `${DESNET_PACKAGE}::profile::register_handle`;

async function fetchRegisteredHandles(): Promise<string[]> {
  if (cachedHandles) return cachedHandles;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("https://api.mainnet.aptoslabs.com/v1/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query Q($fn: String!) {
            user_transactions(
              where: {entry_function_id_str: {_eq: $fn}}
              order_by: {version: desc}
              limit: 1000
            ) { entry_function_id_str }
          }`,
          variables: { fn: REGISTER_HANDLE_FN },
        }),
      }).then((r) => r.json());
      // The user_transactions table doesn't include arguments. We need a
      // different table — `signatures` doesn't have args either.
      // Fallback: walk known on-chain register_handle txs via REST.
      // For now, since indexer schemas keep changing, return the
      // hardcoded baseline (desnet is the only registered handle on
      // mainnet at the moment).
      void res;
    } catch {
      // Indexer unreachable — fall through to hardcoded list.
    }
    // Hardcoded baseline: handles known to exist on mainnet today.
    // TODO: replace with proper indexer query when an `events`-equivalent
    // schema is available. New handles registered after this list goes
    // out of date will still work via free-text input, just won't show
    // in the autocomplete suggestions.
    const list = ["desnet"];
    cachedHandles = list;
    inflight = null;
    return list;
  })();
  return inflight;
}

export function useRegisteredHandles(): string[] {
  const [handles, setHandles] = useState<string[]>(cachedHandles ?? []);
  useEffect(() => {
    let cancelled = false;
    fetchRegisteredHandles().then((list) => {
      if (!cancelled) setHandles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return handles;
}

// ============ Handle validators — mirror profile.move::validate_handle ============
// Lower-case ASCII only, 1-64 bytes, must start with [a-z], rest [a-z0-9_].

export function validateHandle(handle: string): string | null {
  const len = utf8ByteLength(handle);
  if (len < 1) return "Handle too short";
  if (len > 64) return "Handle too long (max 64)";
  if (handle !== handle.toLowerCase()) return "Lowercase only";
  if (!/^[a-z]/.test(handle)) return "Must start with a-z";
  if (!/^[a-z][a-z0-9_]*$/.test(handle)) return "a-z, 0-9, underscore only";
  return null;
}

// ============ utils ============

export function handleBytes(handle: string): number[] {
  return Array.from(new TextEncoder().encode(handle));
}

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function hexToUtf8(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length === 0) return "";
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}
