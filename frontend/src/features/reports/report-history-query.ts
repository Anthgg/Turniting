import type {
  ReportListFilters,
  ReportStatus,
  ReportType,
} from "../../api/reports";

export const REPORT_HISTORY_PAGE_SIZE = 20;

export function createReportHistoryQuery(
  type: ReportType | undefined,
  status: ReportStatus | undefined,
  page: number,
): ReportListFilters {
  return { type, status, page, pageSize: REPORT_HISTORY_PAGE_SIZE };
}
