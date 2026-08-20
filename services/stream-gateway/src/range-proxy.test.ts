import { describe, it, expect } from 'vitest';
import { parseRangeHeader, chunksFor } from './range-proxy.js';

describe('parseRangeHeader', () => {
  const SIZE = 1000;

  it('returns null when no Range header is present', () => {
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
  });

  it('parses a closed range', () => {
    expect(parseRangeHeader('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('parses an open-ended range', () => {
    expect(parseRangeHeader('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('parses a suffix range — FFmpeg uses this to find moov at the end of the file', () => {
    expect(parseRangeHeader('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('clamps an end that runs past the file', () => {
    expect(parseRangeHeader('bytes=990-5000', SIZE)).toEqual({ start: 990, end: 999 });
  });

  it('rejects a start beyond the file', () => {
    expect(parseRangeHeader('bytes=1000-1100', SIZE)).toBeNull();
  });

  it('rejects an inverted range', () => {
    expect(parseRangeHeader('bytes=500-100', SIZE)).toBeNull();
  });

  it('rejects multi-range and malformed forms rather than mis-serving them', () => {
    for (const h of ['bytes=0-10,20-30', 'items=0-10', 'bytes=', 'bytes=-', 'garbage']) {
      expect(parseRangeHeader(h, SIZE)).toBeNull();
    }
  });

  it('handles a suffix larger than the file', () => {
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });
});

describe('chunksFor', () => {
  const CHUNK = 1000;

  it('covers a range inside one chunk', () => {
    expect(chunksFor(10, 20, CHUNK)).toEqual([0]);
  });

  it('covers a range spanning several chunks', () => {
    expect(chunksFor(500, 2500, CHUNK)).toEqual([0, 1, 2]);
  });

  it('includes the chunk containing an exact boundary end', () => {
    expect(chunksFor(0, 1000, CHUNK)).toEqual([0, 1]);
  });

  it('handles a single byte', () => {
    expect(chunksFor(4096, 4096, CHUNK)).toEqual([4]);
  });

  it('produces contiguous ascending indices for a deep range', () => {
    // A seek near the end of a 12 GB file must not enumerate from chunk 0.
    const chunkSize = 4 * 1024 * 1024;
    const start = 11_000_000_000;
    const indices = chunksFor(start, start + chunkSize, chunkSize);
    expect(indices[0]).toBe(Math.floor(start / chunkSize));
    expect(indices).toHaveLength(2);
    expect(indices[1]! - indices[0]!).toBe(1);
  });
});
