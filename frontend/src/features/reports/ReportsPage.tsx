import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import "./ReportsPage.css";
import { CustomSelect } from "../../components/CustomSelect";
import { TurnitingFeedback } from "../../components/TurnitingFeedback";
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
  const hasGeneratingReport = items.some((report) => report.status === "GENERATING");
  const total = reports.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil((reports.data?.total ?? 0) / REPORT_HISTORY_PAGE_SIZE));

  return (
    <main className="dashboard-main reports-page">
      <header className="reports-page-heading">
        <div>
          <p className="reports-eyebrow">BIBLIOTECA DE DOCUMENTOS</p>
          <h1>Reportes PDF</h1>
          <p>Consulta los archivos generados por tus análisis, revisa su vigencia y administra cada reporte.</p>
        </div>
        <Link className="button button-quiet reports-import-link" to="/turnitin-reports">Turnitin importados</Link>
      </header>

      <section className="reports-history-panel" aria-labelledby="report-history-title">
        <div className="reports-history-heading">
          <div>
            <p className="reports-eyebrow">HISTORIAL</p>
            <h2 id="report-history-title">Reportes de Turniting</h2>
            <p>Los PDFs se conservan por tiempo limitado; revisa la fecha de expiración antes de compartirlos.</p>
          </div>
          <span className="reports-history-total" aria-live="polite">
            <strong>{total}</strong> {total === 1 ? "reporte" : "reportes"}
          </span>
        </div>

        <div className="reports-filter-toolbar" aria-label="Filtros de reportes">
          <div className="reports-filter-field">
            <span>Tipo de reporte</span>
            <CustomSelect
              id="reports-type-filter"
              label="Tipo de reporte"
              value={type ?? ""}
              options={[
                { value: "", label: "Todos los tipos" },
                { value: "AI_ORIGINAL_REVIEW", label: "Revisión original" },
                { value: "AI_PARAGRAPH_TECHNICAL", label: "Detalle por párrafos" },
                { value: "AI_REPORT", label: "Reporte IA anterior" },
                { value: "SIMILARITY_REPORT", label: "Similitud" },
              ]}
              onChange={(value) => updateType(value ? value as ReportType : undefined)}
            />
          </div>
          <div className="reports-filter-field">
            <span>Estado</span>
            <CustomSelect
              id="reports-status-filter"
              label="Estado del reporte"
              value={status ?? ""}
              options={statusFilters.map((filter) => ({ value: filter.value ?? "", label: filter.label }))}
              onChange={(value) => updateStatus(value ? value as ReportStatus : undefined)}
            />
          </div>
          <span className="reports-filter-summary">{total} {total === 1 ? "resultado" : "resultados"}</span>
        </div>

        {message && <p className="report-export-note" role="status">{message}</p>}
        {reports.isPending && <TurnitingFeedback state="reading" title="Leyendo el historial" description="Cargando reportes y estados de vigencia…" className="reports-feedback" layout="inline" />}
        {reports.isError && <TurnitingFeedback state="network-error" title="No se pudo cargar el historial de reportes" className="reports-feedback" layout="inline" />}
        {!reports.isPending && !reports.isError && (regenerate.isPending || hasGeneratingReport) && <TurnitingFeedback state="analyzing" title="Generando reporte PDF" description="La generación sigue en curso; la lista se actualizará cuando el servicio informe el resultado." className="reports-feedback" layout="inline" />}
        {download.isPending && <TurnitingFeedback state="reading" title="Preparando descarga" description="Descargando el PDF seleccionado…" className="reports-feedback" layout="inline" />}
        {remove.isError && <TurnitingFeedback state="error" title="No se pudo eliminar el PDF del reporte" className="reports-feedback" layout="inline" />}
        {regenerate.isError && <TurnitingFeedback state="error" title="No se pudo regenerar el reporte" description="Revisa que la corrida original siga disponible." className="reports-feedback" layout="inline" />}
        {download.isError && <TurnitingFeedback state="error" title="No se pudo descargar el PDF" className="reports-feedback" layout="inline" />}
        {reports.data && items.length === 0 && (
          <TurnitingFeedback state="empty" title="No hay reportes para estos filtros" description="Los PDFs generados desde análisis completados aparecerán aquí." className="reports-empty-state" />
        )}

        {items.length > 0 && (
          <div className="reports-history-list" aria-label="Historial de reportes PDF">
            {items.map((report) => {
              const hint = expiryHint(report);
              const canRegenerate = report.status !== "GENERATING";
              const documentName = report.documentName ?? `Documento ${report.documentId.slice(0, 8)}`;
              const runLabel = report.runLabel ?? report.analysisRunId?.slice(0, 8) ?? "—";
              return (
                <article className="reports-history-row" key={report.id}>
                  <span className="reports-pdf-mark" aria-hidden="true">PDF</span>
                  <div className="reports-primary-details">
                    <div className="reports-row-kicker">
                      <span className="reports-type-label">{typeLabel(report.type)}</span>
                      <span className={`reports-status is-${report.status.toLowerCase()}`}>{statusLabel(report.status)}</span>
                    </div>
                    <button
                      type="button"
                      className="reports-document-name"
                      onClick={() => setPreviewReportId(report.id)}
                      title={report.documentName ?? report.documentId}
                    >
                      {documentName}
                    </button>
                    <div className="reports-row-subtitle">
                      <span>Generado <time dateTime={report.generatedAt}>{dateLabel(report.generatedAt)}</time></span>
                      <span className="reports-row-separator" aria-hidden="true">·</span>
                      <span title={report.analysisRunId ?? undefined}>Run {runLabel}</span>
                    </div>
                  </div>

                  <dl className="reports-row-metadata">
                    <div>
                      <dt>Señal global</dt>
                      <dd>{reportScoreLabel(report.run?.globalScore)}</dd>
                    </div>
                    <div>
                      <dt>Modelo</dt>
                      <dd>{reportModelLabel(report)}</dd>
                    </div>
                    <div>
                      <dt>Expira</dt>
                      <dd>
                        {report.status === "AVAILABLE" ? (
                          <>
                            <time dateTime={report.expiresAt}>{dateLabel(report.expiresAt)}</time>
                            {hint && <small className="reports-expiry-hint">{hint}</small>}
                          </>
                        ) : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Tamaño</dt>
                      <dd>{formatSize(report.sizeBytes)}</dd>
                    </div>
                  </dl>

                  <div className="reports-row-actions" aria-label={`Acciones para ${documentName}`}>
                    {report.status === "AVAILABLE" && report.previewAvailable !== false && <button type="button" className="button button-quiet" onClick={() => setPreviewReportId(report.id)} aria-label={`Ver ${typeLabel(report.type)}`}>Ver PDF</button>}
                    {report.status !== "AVAILABLE" && <button type="button" className="button button-quiet" onClick={() => setPreviewReportId(report.id)}>Detalles</button>}
                    {report.status === "AVAILABLE" && <button type="button" className="button button-quiet" disabled={download.isPending} onClick={() => download.mutate(report)}>Descargar</button>}
                    {canRegenerate && isAIReport(report.type) && <button type="button" className="button button-quiet" disabled={regenerate.isPending} onClick={() => regenerate.mutate(report.id)}>Regenerar</button>}
                    {report.status !== "DELETED" && <button type="button" className="button button-quiet button-danger-quiet" disabled={remove.isPending || report.status === "GENERATING"} onClick={() => confirmDelete(report.id)}>Eliminar</button>}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {reports.data && reports.data.total > 0 && (
          <nav className="reports-pagination" aria-label="Paginación de reportes">
            <button className="button button-quiet" type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Anterior</button>
            <span>Página {page} de {pageCount}</span>
            <button className="button button-quiet" type="button" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Siguiente</button>
          </nav>
        )}
      </section>

      {previewReportId && <ReportDetailPanel reportId={previewReportId} onClose={() => setPreviewReportId(null)} />}
    </main>
  );
}
