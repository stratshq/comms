import { describe, it, expect } from 'vitest';
import { toCsv, toJsonl, buildExport, retentionCutoff, type AuditRecord } from '../src/audit';

const NOW = new Date('2026-06-01T00:00:00Z');

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: 'aud_1',
    actorUserId: 'usr_1',
    action: 'conversation.closed',
    entityType: 'conversation',
    entityId: 'conv_1',
    metadata: { reason: 'resolved' },
    createdAt: new Date('2026-05-31T12:00:00Z'),
    ...overrides,
  };
}

describe('toCsv', () => {
  it('writes a header row and CRLF line endings', () => {
    const csv = toCsv([record()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,timestamp,actor_user_id,action,entity_type,entity_id,metadata');
    expect(lines[1]).toContain('aud_1,2026-05-31T12:00:00.000Z,usr_1,conversation.closed');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('emits only a header for no records', () => {
    expect(toCsv([])).toBe('id,timestamp,actor_user_id,action,entity_type,entity_id,metadata\r\n');
  });

  it('renders a null actor as an empty field', () => {
    expect(toCsv([record({ actorUserId: null })]).split('\r\n')[1]).toContain(
      'aud_1,2026-05-31T12:00:00.000Z,,',
    );
  });

  it('quotes fields containing commas, quotes or newlines', () => {
    const csv = toCsv([record({ action: 'tag,added' })]);
    expect(csv).toContain('"tag,added"');

    const quoted = toCsv([record({ action: 'said "hi"' })]);
    expect(quoted).toContain('"said ""hi"""');

    const multiline = toCsv([record({ action: 'line1\nline2' })]);
    expect(multiline).toContain('"line1\nline2"');
  });

  it('serialises metadata as embedded JSON', () => {
    expect(toCsv([record({ metadata: { a: 1 } })])).toContain('"{""a"":1}"');
  });

  it('defuses spreadsheet formula injection', () => {
    // A cell starting with = would be evaluated by Excel on open.
    expect(toCsv([record({ action: '=1+1' })])).toContain("'=1+1");
    expect(toCsv([record({ action: '@SUM(A1)' })])).toContain("'@SUM(A1)");
    expect(toCsv([record({ action: '-2+3' })])).toContain("'-2+3");
    // The apostrophe is only added where it is needed.
    expect(toCsv([record({ action: 'closed' })])).toContain(',closed,');
  });

  it('quotes values with surrounding whitespace so it survives a round trip', () => {
    expect(toCsv([record({ entityId: ' conv_1 ' })])).toContain('" conv_1 "');
  });
});

describe('toJsonl', () => {
  it('writes one JSON object per line, newline-terminated', () => {
    const out = toJsonl([record(), record({ id: 'aud_2' })]);
    const lines = out.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).id).toBe('aud_1');
    expect(JSON.parse(lines[1]!).createdAt).toBe('2026-05-31T12:00:00.000Z');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('returns an empty string for no records', () => {
    expect(toJsonl([])).toBe('');
  });
});

describe('buildExport', () => {
  it('names and types a CSV export', () => {
    const out = buildExport([record()], 'csv', NOW);
    expect(out.filename).toBe('comms-audit-2026-06-01.csv');
    expect(out.contentType).toBe('text/csv; charset=utf-8');
  });

  it('names and types a JSONL export', () => {
    const out = buildExport([record()], 'jsonl', NOW);
    expect(out.filename).toBe('comms-audit-2026-06-01.jsonl');
    expect(out.contentType).toBe('application/x-ndjson; charset=utf-8');
  });
});

describe('retentionCutoff', () => {
  it('returns null when retention is unlimited', () => {
    expect(retentionCutoff(0, NOW)).toBeNull();
    expect(retentionCutoff(-1, NOW)).toBeNull();
  });

  it('subtracts whole days from now', () => {
    expect(retentionCutoff(30, NOW)?.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });
});
