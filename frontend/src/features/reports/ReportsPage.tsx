import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  deleteReport,
  downloadReport,
  listReports,
  regenerateReport,
  reportQueryKeys,
  reportModelLabel,
  reportScoreLabel,
  type ReportArtifact,
  type ReportStatus,
  type ReportType,
} from "../../api/reports";
import { ReportDetailPanel } from "./ReportDetailPanel";
import {
  createReportHistoryQuery,
  REPORT_HISTORY_PAGE_SIZE,
} from "./report-history-query";

const statusFilters: Array<{ label: string; value?: ReportStatus }> = [
  { label: "Todos" },
  { label: "Disponibles", value: "AVAILABLE" },
  { label: "Expirados", value: "EXPIRED" },
  { label: "Eliminados", value: "DELETED" },
];

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No disponible";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatSize(sizeBytes: number | null | undefined) {
  if (sizeBytes == null) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: ReportStatus) {
  const labels: Record<ReportStatus, string> = {
    GENERATING: "Generando",
    AVAILABLE: "Disponible",
    FAILED: "Error",
    ERROR: "Error",
    EXPIRED: "Expirado",
    DELETED: "Eliminado",
  };
  return labels[status];
}

function typeLabel(type: ReportType) {
  switch (type) {
    case "AI_ORIGINAL_REVIEW": return "Revisión original";
    case "AI_PARAGRAPH_TECHNICAL": return "Detalle por párrafos";
    case "AI_REPORT": return "Reporte IA anterior";
    case "SIMILARITY_REPORT": return "Similitud";
  }
}

function isAIReport(type: ReportType) {
  return type === "AI_REPORT" || type === "AI_ORIGINAL_REVIEW" || type === "AI_PARAGRAPH_TECHNICAL";
}

function expiryHint(report: ReportArtifact) {
  if (report.status !== "AVAILABLE") return null;
  const remaining = new Date(report.expiresAt).getTime() - Date.now();
  if (remaining <= 0) return "Expira pronto";
  if (remaining < 2 * 60 * 60 * 1000) return "Menos de 2 h";
  return null;
}

export function ReportsPage() {
  const queryClient = useQueryClient();
  const [type, setType] = useState<ReportType | undefined>();
  const [status, setStatus] = useState<ReportStatus | undefined>();
  const [page, setPage] = useState(1);
  const [previewReportId, setPreviewReportId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const query = createReportHistoryQuery(type, status, page);
  const reports = useQuery({
    queryKey: reportQueryKeys.list(query),
    queryFn: () => listReports(query),
    retry: 1,
  });

  const refreshLists = async () => {
    await queryClient.invalidateQueries({ queryKey: reportQueryKeys.all });
  };
  const remove = useMutation({
    mutationFn: deleteReport,
    onSuccess: async () => {
      setPage(1);
      await refreshLists();
    },
  });
  const regenerate = useMutation({
    mutationFn: regenerateReport,
    onSuccess: async (report) => {
      setMessage(
        report.reused && report.status === "GENERATING"
          ? "Ya se está generando un reporte para esta corrida."
          : report.reused
            ? "Ya existe un reporte vigente para esta corrida."
            : "Se inició la regeneración del reporte.",
      );
      setPage(1);
      await refreshLists();
    },
  });
  const download = useMutation({ mutationFn: downloadReport });

  function confirmDelete(reportId: string) {
    if (!window.confirm("Se eliminará el archivo PDF. El análisis seguirá disponible.")) return;
    setMessage(null);
    remove.mutate(reportId);
  }

  function updateType(value: ReportType | undefined) {
    setType(value);
    setPage(1);
  }

  function updateStatus(value: ReportStatus | undefined) {
    setStatus(value);
    setPage(1);
  }

  const items = reports.data?.items ?? [];
  const pageCount = Math.max(1, Math.ceil((reports.data?.total ?? 0) / REPORT_HISTORY_PAGE_SIZE));

  return (
    <div className="dashboard-main report-history-page">
      <div className="page-heading documents-page-heading">
        <div>
          <p className="eyebrow">DOCUMENTOS GENERADOS POR TURNITING</p>
          <h1>Reportes</h1>
          <p className="page-subtitle">Consulta, descarga y administra reportes independientes de análisis de IA.</p>
        </div>
        <Link className="button button-quiet" to="/turnitin-reports">Turnitin importados</Link>
      </div>

      <section className="report-history-section" aria-labelledby="report-history-title">
        <div className="report-history-heading">
          <div>
            <p className="eyebrow">HISTORIAL GLOBAL</p>
            <h2 id="report-history-title">Reportes de Turniting</h2>
          </div>
          <span className="report-history-total">{reports.data?.total ?? 0} reportes</span>
        </div>

        <div className="report-filter-toolbar" aria-label="Filtros de reportes">
          <div className="report-filter-group" aria-label="Tipo de reporte">
            <button type="button" className={!type ? "is-selected" : ""} aria-pressed={!type} onClick={() => updateType(undefined)}>Todos</button>
            <button type="button" className={type === "AI_ORIGINAL_REVIEW" ? "is-selected" : ""} aria-pressed={type === "AI_ORIGINAL_REVIEW"} onClick={() => updateType("AI_ORIGINAL_REVIEW")}>Revisión original</button>
            <button type="button" className={type === "AI_PARAGRAPH_TECHNICAL" ? "is-selected" : ""} aria-pressed={type === "AI_PARAGRAPH_TECHNICAL"} onClick={() => updateType("AI_PARAGRAPH_TECHNICAL")}>Detalle por párrafos</button>
            <button type="button" className={type === "AI_REPORT" ? "is-selected" : ""} aria-pressed={type === "AI_REPORT"} onClick={() => updateType("AI_REPORT")}>IA anterior</button>
            <button type="button" className={type === "SIMILARITY_REPORT" ? "is-selected" : ""} aria-pressed={type === "SIMILARITY_REPORT"} onClick={() => updateType("SIMILARITY_REPORT")}>Similitud</button>
          </div>
          <div className="report-filter-group" aria-label="Estado del reporte">
            {statusFilters.map((filter) => (
              <button
                type="button"
                key={filter.label}
                className={status === filter.value ? "is-selected" : ""}
                aria-pressed={status === filter.value}
                onClick={() => updateStatus(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {message && <p className="report-export-note" role="status">{message}</p>}
        {remove.isError && <p className="report-export-error" role="alert">No se pudo eliminar el PDF del reporte.</p>}
        {regenerate.isError && <p className="report-export-error" role="alert">No se pudo regenerar el reporte. Revisa que la corrida original siga disponible.</p>}
        {download.isError && <p className="report-export-error" role="alert">No se pudo descargar el PDF.</p>}
        {reports.isPending && <p className="report-export-note" role="status">Cargando historial…</p>}
        {reports.isError && <p className="report-export-error" role="alert">No se pudo cargar el historial de reportes.</p>}
        {reports.data && items.length === 0 && (
          <div className="report-history-empty">
            <strong>No hay reportes para estos filtros.</strong>
            <span>Los PDFs generados desde análisis completados aparecerán aquí.</span>
          </div>
        )}

        {items.length > 0 && (
          <div className="report-table-wrap">
            <table className="report-history-table">
              <thead>
                <tr><th>Tipo</th><th>Documento</th><th>Run</th><th>Señal global</th><th>Modelo</th><th>Estado</th><th>Generado</th><th>Expira</th><th>Tamaño</th><th>Acciones</th></tr>
              </thead>
              <tbody>
                {items.map((report) => {
                  const hint = expiryHint(report);
                  const canRegenerate = report.status !== "GENERATING";
                  return (
                    <tr key={report.id}>
                      <td data-label="Tipo">{typeLabel(report.type)}</td>
                      <td data-label="Documento" className="report-document-cell">
                        <button type="button" className="button button-quiet" onClick={() => setPreviewReportId(report.id)} title={report.documentName ?? report.documentId}>{report.documentName ?? `Documento ${report.documentId.slice(0, 8)}`}</button>
                      </td>
                      <td data-label="Run">{report.runLabel ?? report.analysisRunId?.slice(0, 8) ?? "—"}</td>
                      <td data-label="Señal global">{reportScoreLabel(report.run?.globalScore)}</td>
                      <td data-label="Modelo">{reportModelLabel(report)}</td>
                      <td data-label="Estado"><span className={`report-artifact-status is-${report.status.toLowerCase()}`}>{statusLabel(report.status)}</span></td>
                      <td data-label="Generado">{dateLabel(report.generatedAt)}</td>
                      <td data-label="Expira">
                        {report.status === "AVAILABLE" ? <><time dateTime={report.expiresAt}>{dateLabel(report.expiresAt)}</time>{hint && <small className="report-expiry-hint">{hint}</small>}</> : "—"}
                      </td>
                      <td data-label="Tamaño">{formatSize(report.sizeBytes)}</td>
                      <td data-label="Acciones" className="report-row-actions">
                        {report.status === "AVAILABLE" && report.previewAvailable !== false && <button type="button" className="button button-quiet" onClick={() => setPreviewReportId(report.id)} aria-label={`Ver ${typeLabel(report.type)}`}>Ver PDF</button>}
                        {report.status !== "AVAILABLE" && <button type="button" className="button button-quiet" onClick={() => setPreviewReportId(report.id)}>Detalles</button>}
                        {report.status === "AVAILABLE" && <button type="button" className="button button-quiet" disabled={download.isPending} onClick={() => download.mutate(report)}>Descargar</button>}
                        {canRegenerate && isAIReport(report.type) && <button type="button" className="button button-quiet" disabled={regenerate.isPending} onClick={() => regenerate.mutate(report.id)}>Regenerar</button>}
                        {report.status !== "DELETED" && <button type="button" className="button button-quiet button-danger-quiet" disabled={remove.isPending || report.status === "GENERATING"} onClick={() => confirmDelete(report.id)}>Eliminar</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {reports.data && reports.data.total > 0 && (
          <nav className="report-pagination" aria-label="Paginación de reportes">
            <button className="button button-quiet" type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button>
            <span>Página {page} de {pageCount}</span>
            <button className="button button-quiet" type="button" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Siguiente</button>
          </nav>
        )}
      </section>

      {previewReportId && <ReportDetailPanel reportId={previewReportId} onClose={() => setPreviewReportId(null)} />}
    </div>
  );
}
