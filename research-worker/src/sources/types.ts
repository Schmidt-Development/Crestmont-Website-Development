// A business record as read from an open dataset, before any verification. Field values are exactly what the source
// says (normalized only); nothing is inferred here.
import type { SourceRef } from "../../../src/domain/research.ts";

export interface Candidate {
  businessKey: string;              // "<source>:<source id>" — stable across releases (Overture GERS id, FSQ place id, OSM n/w/r id)
  name: string;
  category: string | null;
  address: { line: string | null; city: string | null; state: string | null; zip: string | null };
  lat: number | null;
  lon: number | null;
  phones: string[];                 // E.164
  emails: string[];
  websites: string[];               // raw website values from the source (may include social/directory links)
  sources: SourceRef[];
  sourceConfidence: number | null;  // the dataset's own existence confidence, when it publishes one
  operatingStatus: string | null;   // e.g. "open" / "permanently_closed" when published
}

export interface SourceAdapter {
  readonly id: "overture" | "foursquare_os" | "osm_geofabrik";
  /** Prepares a local snapshot for the release (resumable) and returns its identifier. */
  prepare(): Promise<{ release: string }>;
  /** Streams candidates for one state from the local snapshot. */
  candidates(state: string): AsyncIterable<Candidate>;
}
