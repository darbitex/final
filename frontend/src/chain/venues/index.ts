import type { VenueAdapter } from "./types";
import { cellanaAdapter } from "./cellana";
import { hyperionAdapter } from "./hyperion";
import { thalaAdapter } from "./thala";

// Registered external venues. Add new adapters here to wire them into
// the Aggregator page automatically.
export const EXTERNAL_VENUES: VenueAdapter[] = [
  thalaAdapter,
  hyperionAdapter,
  cellanaAdapter,
];

export type { VenueAdapter, VenueQuote } from "./types";
