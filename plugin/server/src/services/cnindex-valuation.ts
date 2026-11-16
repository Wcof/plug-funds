import { createHash } from 'node:crypto';
import type { DbHandle } from '../db.ts';
import type { CnindexMetric } from '../market/cnindex.ts';
import { archiveIndexQuoteMetric, officialIndexMetricProvider, saveValuationMetric } from '../repo/market.ts';

/** 国证与中证口径不拼接；原报价独立留档，覆盖同日原值时记录前后证据。 */
export function saveCnindexMetrics(handle: DbHandle, instrumentId: string, metrics: CnindexMetric[]): CnindexMetric[] {
  const accepted = metrics.filter((metric) => officialIndexMetricProvider(handle, instrumentId, metric.metricKey) !== 'csindex');
  const changes: unknown[] = [];
  handle.db.exec('SAVEPOINT cnindex_metrics;');
  try {
    for (const key of ['pe', 'pb'] as const) if (accepted.some((metric) => metric.metricKey === key)) {
      archiveIndexQuoteMetric(handle, instrumentId, key);
    }
    for (const metric of accepted) {
      const before = handle.db.prepare('SELECT * FROM valuation_metrics WHERE instrument_id=? AND metric_key=? AND as_of_date=?')
        .get(instrumentId, metric.metricKey, metric.asOfDate);
      const after = { ...metric, instrumentId, provider: 'cnindex' };
      if (before && (before.value !== metric.value || before.provider !== 'cnindex' || before.quality !== metric.quality)) changes.push({ before, after });
      saveValuationMetric(handle, after);
    }
    if (changes.length) {
      const note = JSON.stringify({ kind: 'cnindex-metrics-update', instrumentId, changes });
      const id = `cnindex-${createHash('sha256').update(note).digest('hex')}`;
      const now = new Date().toISOString();
      handle.db.prepare('INSERT OR IGNORE INTO data_source_runs (id,started_at,finished_at,instruments,ok,failed,note) VALUES (?,?,?,?,?,?,?)')
        .run(id, now, now, 1, 1, 0, note);
    }
    handle.db.exec('RELEASE cnindex_metrics;');
    return accepted;
  } catch (error) {
    handle.db.exec('ROLLBACK TO cnindex_metrics; RELEASE cnindex_metrics;');
    throw error;
  }
}
