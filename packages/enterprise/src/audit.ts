/* @license Enterprise */

/**
 * Audit log retention and export.
 *
 * The `audit_logs` table, and every write to it, is open source and always on —
 * an inbox that quietly stops recording who closed a ticket is a worse product,
 * not a cheaper one. What is licensed here is the compliance surface a customer
 * with an auditor needs: retention windows, filtered export, and a file their
 * SIEM will accept.
 */

/** The subset of an `audit_logs` row an export needs. Structural, so this package stays db-free. */
export interface AuditRecord {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Retention windows offered in the admin panel, in days. `0` means keep forever. */
export const RETENTION_PRESETS = [0, 30, 90, 180, 365, 730] as const;

export type RetentionDays = (typeof RETENTION_PRESETS)[number];

/**
 * The timestamp before which records may be pruned, or null to keep everything.
 * Callers delete `createdAt < cutoff`.
 */
export function retentionCutoff(days: number, now: Date = new Date()): Date | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * 86_400_000);
}

const EXPORT_COLUMNS = [
  'id',
  'timestamp',
  'actor_user_id',
  'action',
  'entity_type',
  'entity_id',
  'metadata',
] as const;

/**
 * Neutralise spreadsheet formula injection.
 *
 * Audit exports are opened in Excel by the people least equipped to notice that
 * a ticket subject started with `=`. Anything a formula parser would evaluate
 * gets a leading apostrophe, which Excel and Sheets both strip on display.
 */
function defuse(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Quote a single CSV field per RFC 4180. */
function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ''
      : value instanceof Date
        ? value.toISOString()
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);

  const safe = defuse(raw);
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Serialise records to RFC 4180 CSV with a header row.
 *
 * Returns a string rather than streaming: a compliance export is bounded by the
 * retention window the customer chose, and every SIEM importer wants a whole
 * file. Stream from the caller if an install ever outgrows that.
 */
export function toCsv(records: readonly AuditRecord[]): string {
  const rows = [EXPORT_COLUMNS.join(',')];
  for (const r of records) {
    rows.push(
      [
        csvCell(r.id),
        csvCell(r.createdAt),
        csvCell(r.actorUserId),
        csvCell(r.action),
        csvCell(r.entityType),
        csvCell(r.entityId),
        csvCell(r.metadata),
      ].join(','),
    );
  }
  // Trailing newline: POSIX tools and several SIEM importers drop a final
  // unterminated line.
  return `${rows.join('\r\n')}\r\n`;
}

/**
 * Serialise to newline-delimited JSON, which most log pipelines ingest directly.
 * Dates become ISO 8601 strings via the default `Date` serialiser.
 */
export function toJsonl(records: readonly AuditRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

export type AuditExportFormat = 'csv' | 'jsonl';

export interface AuditExport {
  filename: string;
  contentType: string;
  body: string;
}

/** Build a downloadable export, named for the day it was produced. */
export function buildExport(
  records: readonly AuditRecord[],
  format: AuditExportFormat,
  now: Date = new Date(),
): AuditExport {
  const stamp = now.toISOString().slice(0, 10);
  return format === 'csv'
    ? {
        filename: `comms-audit-${stamp}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: toCsv(records),
      }
    : {
        filename: `comms-audit-${stamp}.jsonl`,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: toJsonl(records),
      };
}
