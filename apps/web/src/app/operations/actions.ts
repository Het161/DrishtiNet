'use server';

/**
 * Search runs on the server so the query stays next to the database.
 *
 * The alternative — shipping rows to the browser and filtering there — would mean sending the whole
 * index to every operator and would make the sub-200 ms budget meaningless, since the measurement
 * would no longer include the part that actually takes the time.
 */
import { searchSignatures, type SearchResult } from '@/lib/forensics';

export async function runSearch(filters: {
  cls?: string;
  colour?: string;
  cameraId?: string;
  plate?: string;
}): Promise<SearchResult> {
  return searchSignatures({
    // Empty strings come from unset <select> options and must not become filters that match nothing.
    cls: filters.cls || undefined,
    colour: filters.colour || undefined,
    cameraId: filters.cameraId || undefined,
    plate: filters.plate || undefined,
    limit: 100,
  });
}
