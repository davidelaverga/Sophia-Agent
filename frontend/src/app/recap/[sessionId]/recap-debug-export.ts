import { downloadTextFile } from '../../lib/download-file';
import { buildRecapTelemetryReport, type RecapTelemetryReport } from '../../lib/recap-telemetry-report';

import type { RecapPageStatus } from './useRecapArtifactsLoader';

type BuildRecapDebugExportParams = Omit<Parameters<typeof buildRecapTelemetryReport>[0], 'pageStatus'> & {
  pageStatus: RecapPageStatus;
  autoRefreshing: boolean;
};

/**
 * The content-free telemetry report plus the raw page status, so a report
 * exported from processing, failure or empty states says which view was shown.
 * `buildRecapTelemetryReport` copies only counts, states and identifiers:
 * never candidate text, takeaways, edits or the owner id.
 */
export type RecapDebugExport = RecapTelemetryReport & {
  pageStatus: RecapPageStatus;
  processingAutoRefresh: boolean | null;
};

export function buildRecapDebugExport({
  pageStatus,
  autoRefreshing,
  ...params
}: BuildRecapDebugExportParams): RecapDebugExport {
  return {
    ...buildRecapTelemetryReport({ ...params, pageStatus }),
    pageStatus,
    processingAutoRefresh: pageStatus === 'processing' ? autoRefreshing : null,
  };
}

export function downloadRecapDebugExport(report: RecapDebugExport): boolean {
  const stamp = report.exportedAt.replace(/[:.]/g, '-');
  return downloadTextFile({
    text: JSON.stringify(report, null, 2),
    filename: `sophia-recap-telemetry-report-${report.session.sessionId}-${stamp}.json`,
    mimeType: 'application/json',
  }).ok;
}
