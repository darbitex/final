import { APT_USD_PYTH_FEED, HERMES_ENDPOINT } from "../config";

// Hermes returns base64-encoded VAAs for each feed id. ONE's *_pyth entry
// wrappers expect `vector<vector<u8>>` — one inner vector per feed. We
// only depend on APT/USD so the outer array has one element.
//
// IMPORTANT: wallet adapters (Petra, Pontem, Martian) serialize
// `functionArguments` via JSON. Uint8Array round-trips inconsistently
// across wallet extensions; `number[]` is the canonical shape that
// matches the proven bootstrap path (`aptos/deploy-scripts/bootstrap.js`
// used Array.from(uint8) before submit). Return number[][] here.
export async function fetchAptUsdVaa(): Promise<number[][]> {
  const url = `${HERMES_ENDPOINT}/v2/updates/price/latest?ids[]=${APT_USD_PYTH_FEED}&encoding=base64`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Hermes ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as {
    binary?: { encoding?: string; data?: string[] };
  };
  const arr = body.binary?.data;
  if (!arr || arr.length === 0) {
    throw new Error("Hermes returned no VAA data");
  }
  return arr.map(base64ToNumberArray);
}

function base64ToNumberArray(b64: string): number[] {
  const bin = atob(b64);
  const out: number[] = new Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
