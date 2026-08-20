import { describe, it, expect } from 'vitest';
import { splitStatements } from './post-migrate.js';

describe('splitStatements', () => {
  it('splits plain statements on semicolons', () => {
    const out = splitStatements('CREATE INDEX a ON t (x);\nCREATE INDEX b ON t (y);\n');
    expect(out).toHaveLength(2);
  });

  it('keeps a $$-quoted function body intact despite its inner semicolons', () => {
    const sql = `
CREATE OR REPLACE FUNCTION f() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'no';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE INDEX after ON t (x);
`;
    const out = splitStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('RAISE EXCEPTION');
    expect(out[0]).toContain('LANGUAGE plpgsql');
    expect(out[1]).toContain('CREATE INDEX after');
  });

  it('drops comment-only fragments', () => {
    const out = splitStatements('-- just a comment\n-- another;\nSELECT 1;\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('SELECT 1');
  });

  it('returns nothing for an empty file', () => {
    expect(splitStatements('')).toEqual([]);
  });
});
