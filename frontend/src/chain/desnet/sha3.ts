// SHA3-256 helper for Aptos `object::create_named_object` deterministic
// address derivation. Used by the Tier-3 (B3) asset orchestrator to
// pre-compute every chunk + node address before any tx is signed.
//
// Aptos formula for `object::create_object_address(creator, seed)`:
//   addr_bytes = sha3_256( creator_addr_bytes || seed_bytes || 0xFE )
//   where 0xFE is the OBJECT_FROM_SEED_DERIVE_SCHEME byte.
//
// Reference: aptos-core/crates/aptos-types/src/account_address.rs
//   pub fn from_seed(seed: &[u8]) -> AccountAddress { ... DeriveScheme::ObjectAddressFromGuid }
//
// Cross-checked against assets.move's `derive_master_addr_v2` and
// `derive_chunk_addr_v2` views — JS-derived addrs MUST match the on-chain
// view results exactly, otherwise the script tx aborts E_ROOT_MISMATCH
// during finalize_v2(verify_seed=true). A unit test against the live view
// is part of the deploy smoke checklist.

import { sha3_256 } from "@noble/hashes/sha3";

const OBJECT_FROM_SEED_DERIVE_SCHEME = 0xfe;

/// Convert a 0x-prefixed lowercase address string into 32 raw bytes
/// (left-padded with zeros if the input was short-stripped).
export function addrToBytes(addr: string): Uint8Array {
  let h = addr.startsWith("0x") || addr.startsWith("0X") ? addr.slice(2) : addr;
  h = h.toLowerCase();
  if (h.length > 64 || !/^[0-9a-f]*$/.test(h)) {
    throw new Error(`Invalid Aptos address: ${addr}`);
  }
  h = h.padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function bytesToAddrHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error(`Expected 32-byte address, got ${bytes.length}`);
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/// Mirror of Move's `object::create_object_address(creator, seed)`.
/// Returns a canonical lowercase 0x + 64-hex address string.
export function createObjectAddress(creator: string, seed: Uint8Array): string {
  const creatorBytes = addrToBytes(creator);
  const buf = new Uint8Array(creatorBytes.length + seed.length + 1);
  buf.set(creatorBytes, 0);
  buf.set(seed, creatorBytes.length);
  buf[creatorBytes.length + seed.length] = OBJECT_FROM_SEED_DERIVE_SCHEME;
  return bytesToAddrHex(sha3_256(buf));
}

// ============ BCS encoding helpers (just enough for our seeds) ============

/// BCS-encode a u64 as little-endian 8 bytes.
export function bcsU64(n: bigint | number): Uint8Array {
  const v = typeof n === "bigint" ? n : BigInt(n);
  const out = new Uint8Array(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/// BCS-encode an address (just the 32 raw bytes, no length prefix).
export function bcsAddr(addr: string): Uint8Array {
  return addrToBytes(addr);
}

/// Concat byte arrays.
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ============ DeSNet asset seed builders (mirror assets.move) ============

const SEED_PREFIX_MASTER = new TextEncoder().encode("desnet/asset/master/");
const SEED_PREFIX_CHUNK = new TextEncoder().encode("desnet/asset/chunk/");
const SEED_PREFIX_NODE = new TextEncoder().encode("desnet/asset/node/");

/// Pre-compute master addr — must match `derive_master_addr_v2(uploader, nonce)`.
export function deriveMasterAddrV2(uploader: string, nonce: bigint | number): string {
  const seed = concatBytes(SEED_PREFIX_MASTER, bcsU64(nonce));
  return createObjectAddress(uploader, seed);
}

/// Pre-compute chunk addr — must match `derive_chunk_addr_v2(uploader, master, idx)`.
export function deriveChunkAddrV2(
  uploader: string,
  masterAddr: string,
  chunkIndex: bigint | number,
): string {
  const seed = concatBytes(SEED_PREFIX_CHUNK, bcsAddr(masterAddr), bcsU64(chunkIndex));
  return createObjectAddress(uploader, seed);
}

/// Pre-compute node addr — must match `derive_node_addr_v2(uploader, master, idx)`.
export function deriveNodeAddrV2(
  uploader: string,
  masterAddr: string,
  nodeIndex: bigint | number,
): string {
  const seed = concatBytes(SEED_PREFIX_NODE, bcsAddr(masterAddr), bcsU64(nodeIndex));
  return createObjectAddress(uploader, seed);
}
