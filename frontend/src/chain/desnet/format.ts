// Shared display + safety helpers for DeSNet pages.
//
// Consolidated 2026-05-03 audit pass — `shortAddr` was duplicated in
// 4 files; address normalization was naive `.toLowerCase()` and would
// miss equality between e.g. `0xabc` and `0x000…0abc` (Aptos addresses
// are 32 bytes, leading zeros are commonly stripped in display).

// ============ Aptos address normalization (M2 fix) ============

/// Canonicalize an Aptos address to lowercase 0x-prefixed 64-hex form.
/// Pads with leading zeros if the input came back short-stripped.
/// Throws if the input is malformed (non-hex or > 32 bytes).
export function normalizeAptosAddr(addr: string): string {
  if (!addr) return addr;
  let h = addr.toLowerCase();
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length === 0 || !/^[0-9a-f]+$/.test(h) || h.length > 64) {
    throw new Error(`Invalid Aptos address: ${addr}`);
  }
  return "0x" + h.padStart(64, "0");
}

/// Equality on canonical-form Aptos addresses. ALWAYS use this instead of
/// `a.toLowerCase() === b.toLowerCase()` — addresses with different
/// leading-zero stripping but the same value would otherwise mis-compare.
export function aptosAddrEq(a: string, b: string): boolean {
  try {
    return normalizeAptosAddr(a) === normalizeAptosAddr(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

// ============ Display formatters (M1) ============

/// `0x1234abcd…ef01` short-form for UI rows.
export function shortAddr(a: string): string {
  if (!a || a.length < 14) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}

// ============ Bytes/base64/MIME (M1) ============

export function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function bytesToAddress(bytes: Uint8Array): string | null {
  if (bytes.length !== 32) return null;
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/// Best-effort MIME sniff from the leading bytes of a base64 image string.
/// Returns "application/octet-stream" when no signature matches — caller
/// should treat that as "render the letter-fallback avatar".
export function guessMimeFromB64(b64: string): string {
  if (b64.startsWith("iVBORw")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("PHN2") || b64.startsWith("PD94") || b64.startsWith("PHN2Zw")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

// ============ SVG sanitization (L1 hardening) ============

/// Browsers DO sandbox SVG when rendered via `<img>` (no script execution),
/// but defense-in-depth: strip `<script>` blocks, inline event handlers
/// (`onclick="…"` etc.), and `javascript:` URLs from any SVG bytes before
/// re-encoding back to base64. Mostly relevant if the rendering path ever
/// changes to `<object>` or `<iframe>`. Safe to apply unconditionally.
export function sanitizeSvgB64(b64: string): string | null {
  try {
    const decoded = atob(b64);
    const sanitized = decoded
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<script[^>]*\/>/gi, "")
      .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:/gi, "$1=$2#blocked:")
      .replace(/javascript\s*:/gi, "blocked:");
    return btoa(sanitized);
  } catch {
    return null;
  }
}

/// One-shot: returns a `data:` URL for inline media, sanitizing SVG if needed.
/// Returns null if MIME is unsupported / data unrenderable.
export function safeImageDataUrl(b64: string, mime: string): string | null {
  if (mime === "application/octet-stream") return null;
  if (mime === "image/svg+xml") {
    const safe = sanitizeSvgB64(b64);
    if (!safe) return null;
    return `data:image/svg+xml;base64,${safe}`;
  }
  return `data:${mime};base64,${b64}`;
}

// ============ Number formatting (L6) ============

/// Number → string for inputs without scientific notation.
/// Used by "max" buttons so very small balances (e.g. `1e-7` APT) render
/// as `0.00000010` rather than `1e-7` (which `<input type=number>`
/// accepts but most users find unreadable).
export function formatNumberForInput(n: number, maxDecimals = 8): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  // Avoid scientific notation for small numbers
  if (Math.abs(n) < 1e-4) {
    return n.toFixed(maxDecimals).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(n);
}
