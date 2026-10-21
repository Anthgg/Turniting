import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../../api/client";
import { analysisQueryKeys, listDocumentAnalyses } from "../../api/analysis";
import {
  downloadReport,
  deleteReport,
  generateAIReport,
  generateBothAIReports,
  listDocumentReports,
  regenerateReport,
  reportQueryKeys,
  reportModelLabel,
  reportScoreLabel,
  type ReportArtifact,
  type ReportType,
} from "../../api/reports";
import { ReportDetailPanel } from "../reports/ReportDetailPanel";

function expiryLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "fecha no disponible";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function expiryHint(report: ReportArtifact) {
  if (report.status !== "AVAILABLE") return null;
  const remaining = new Date(report.expiresAt).getTime() - Date.now();
  return remaining > 0 && remaining < 2 * 60 * 60 * 1000
    ? "Menos de 2 h"
    : null;
}

function reportStatusLabel(report: ReportArtifact): string {
  switch (report.status) {
    case "GENERATING":
      return "Generando…";
    case "AVAILABLE":
      return "Disponible";
    case "FAILED":
      return "Error al generar";
    case "EXPIRED":
      return "Expirado";
    case "ERROR":
      return "Error al generar";
    case "DELETED":
      return "Eliminado";
  }
}

function reportVariantLabel(type: ReportType): string {
  switch (type) {
    case "AI_ORIGINAL_REVIEW":
      return "Revisión original";
    case "AI_PARAGRAPH_TECHNICAL":
      return "Detalle por párrafos";
    case "SIMILARITY_REPORT":
      return "Similitud";
    default:
      return "Reporte IA anterior";
  }
}

export function ReportExportPanel({
  documentId,
  canExport,
}: {
  documentId: string;
  canExport: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [previewReportId, setPreviewReportId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const analyses = useQuery({
    queryKey: analysisQueryKeys.documentAnalyses(documentId),
    queryFn: () => listDocumentAnalyses(documentId),
    enabled: Boolean(documentId) && canExport,
    retry: 1,
  });
  const reports = useQuery({
    queryKey: reportQueryKeys.document(documentId),
    queryFn: () => listDocumentReports(documentId),
    enabled: Boolean(documentId),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === "GENERATING")
        ? 1_500
        : false,
  });

  const completedRuns = useMemo(
    () =>
      (analyses.data?.items ?? []).filter((run) => run.status === "COMPLETED"),
    [analyses.data?.items],
  );
  const selectedRun =
    selectedRunId === null
      ? completedRuns[0]
      : completedRuns.find((run) => run.id === selectedRunId);

  // React immediately retries this component with the initial run locked.
  // Later query refreshes cannot move the cards to another analysis.
  if (selectedRunId === null && selectedRun) setSelectedRunId(selectedRun.id);

  const generate = useMutation({
    mutationFn: ({ runId, variant }: { runId: string; variant: ReportType }) =>
      generateAIReport(documentId, runId, variant),
    onSuccess: async (report) => {
      setMessage(
        report.reused && report.status === "GENERATING"
          ? "Ya se está generando un reporte para esta corrida."
          : report.reused
            ? "Ya existe un reporte vigente para esta corrida."
            : "El reporte IA comenzó a generarse.",
      );
      await queryClient.invalidateQueries({
        queryKey: reportQueryKeys.document(documentId),
      });
    },
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: reportQueryKeys.document(documentId),
      });
    },
  });
  const download = useMutation({ mutationFn: downloadReport });
  const remove = useMutation({
    mutationFn: deleteReport,
    onSuccess: async () => {
      setMessage("El archivo PDF se eliminó. El análisis sigue disponible.");
      await queryClient.invalidateQueries({ queryKey: reportQueryKeys.all });
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
            : "La regeneración del reporte IA comenzó.",
      );
      await queryClient.invalidateQueries({ queryKey: reportQueryKeys.all });
    },
  });

  const generateBoth = useMutation({
    mutationFn: (runId: string) => generateBothAIReports(documentId, runId),
    onSuccess: async () => {
      setMessage("Ambos reportes usan la misma corrida de análisis.");
      await queryClient.invalidateQueries({ queryKey: reportQueryKeys.all });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: reportQueryKeys.all });
    },
  });

  const currentReports = (reports.data?.items ?? []).filter(
    (report) => report.documentId === documentId,
  );
  const aiReports = currentReports.filter(
    (report) => report.type !== "SIMILARITY_REPORT",
  );
  const selectedOriginalReport = aiReports.find(
    (report) =>
      report.type === "AI_ORIGINAL_REVIEW" &&
      report.analysisRunId === selectedRun?.id,
  );
  const selectedTechnicalReport = aiReports.find(
    (report) =>
      report.type === "AI_PARAGRAPH_TECHNICAL" &&
      report.analysisRunId === selectedRun?.id,
  );
  const availableSimilarity = currentReports.find(
    (report) =>
      report.type === "SIMILARITY_REPORT" &&
      report.status === "AVAILABLE" &&
      report.similarityRunId,
  );
  const errorMessage = (error: unknown) =>
    error instanceof ApiRequestError
      ? error.message
      : "No se pudo completar la operación.";
  const generationPending = generate.isPending || regenerate.isPending || generateBoth.isPending;
  const variantCards = [
    {
      variant: "AI_ORIGINAL_REVIEW" as const,
      title: "Revisión sobre documento original",
      action: "revisión original",
      description: "Conserva la maquetación del archivo y resalta los segmentos evaluados que cumplen el criterio de revisión visual, independiente del umbral del detector.",
      report: selectedOriginalReport,
    },
    {
      variant: "AI_PARAGRAPH_TECHNICAL" as const,
      title: "Detalle técnico por párrafos",
      action: "detalle por párrafos",
      description: "Muestra el score local, el umbral, el estado, las exclusiones y el texto completo de cada segmento.",
      report: selectedTechnicalReport,
    },
  ];

  return (
    <section
      className="document-panel report-export-panel"
      aria-labelledby="report-export-title"
    >
      <div className="document-panel-heading">
        <div>
          <p className="eyebrow">REPORTES DE IA</p>
          <h2 id="report-export-title">Reportes PDF</h2>
        </div>
      </div>
      {completedRuns.length > 1 && (
        <label className="report-run-select">
          <span>Corrida para ambos reportes</span>
          <select
            value={selectedRun?.id ?? ""}
            onChange={(event) => setSelectedRunId(event.currentTarget.value)}
          >
            {completedRuns.map((run) => (
              <option value={run.id} key={run.id}>
                {new Date(run.completedAt ?? run.createdAt).toLocaleString(
                  "es-PE",
                )}{" "}
                · {run.analyzerMode} · {run.paragraphMode ?? "sin modo"}
              </option>
            ))}
          </select>
        </label>
      )}
      {selectedRun && (
        <p className="report-export-note" data-analysis-run-id={selectedRun.id}>
          Ambos reportes: corrida {selectedRun.id.slice(0, 8)} · Señal global {reportScoreLabel(selectedRun.documentScore)} · Umbral {reportScoreLabel(selectedRun.threshold)} · {selectedRun.analyzerMode}
        </p>
      )}
      <button
        className="button button-primary"
        type="button"
        onClick={() => selectedRun && generateBoth.mutate(selectedRun.id)}
        disabled={!canExport || !selectedRun || generationPending || selectedOriginalReport?.status === "GENERATING" || selectedTechnicalReport?.status === "GENERATING"}
        aria-busy={generateBoth.isPending}
      >
        {generateBoth.isPending ? "Generando ambos…" : "Generar ambos reportes"}
      </button>
      <div className="report-export-actions">
        {variantCards.map(({ variant, title, action, description, report }) => (
          <div className="report-export-action" data-report-variant={variant} key={variant}>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
              {report?.run && <p data-analysis-run-id={report.analysisRunId ?? undefined}>Corrida {report.analysisRunId?.slice(0, 8)} · Señal {reportScoreLabel(report.run.globalScore)} · Umbral {reportScoreLabel(report.run.threshold)} · {reportModelLabel(report)}</p>}
            </div>
            <div className="report-row-actions">
              {report?.status === "AVAILABLE" && <>
                <button className="button button-primary" type="button" onClick={() => setPreviewReportId(report.id)}>Ver {action}</button>
                <button className="button button-quiet" type="button" onClick={() => download.mutate(report)} disabled={download.isPending}>Descargar {action}</button>
              </>}
              <button
                className={report?.status === "AVAILABLE" ? "button button-quiet" : "button button-primary"}
                type="button"
                onClick={() => {
                  if (report) regenerate.mutate(report.id);
                  else if (selectedRun) generate.mutate({ runId: selectedRun.id, variant });
                }}
                disabled={!canExport || !selectedRun || generationPending || report?.status === "GENERATING"}
                aria-busy={generationPending || report?.status === "GENERATING"}
              >
                {generationPending || report?.status === "GENERATING" ? "Generando…" : `${report ? "Regenerar" : "Generar"} ${action}`}
              </button>
            </div>
          </div>
        ))}

        <div className="report-export-action">
          <div>
            <h3>Reporte independiente de similitud</h3>
            <p>
              {availableSimilarity
                ? "Hay un reporte compatible con un análisis de similitud persistido."
                : "Aún no existe un análisis de similitud para esta versión."}
            </p>
          </div>
          <button
            className="button button-quiet"
            type="button"
            title={
              availableSimilarity
                ? undefined
                : "Aún no existe un análisis de similitud para esta versión."
            }
            disabled={!availableSimilarity || download.isPending}
            onClick={() =>
              availableSimilarity && download.mutate(availableSimilarity)
            }
            aria-busy={
              download.isPending &&
              download.variables?.type === "SIMILARITY_REPORT"
            }
          >
            {download.isPending &&
            download.variables?.type === "SIMILARITY_REPORT"
              ? "Descargando…"
              : "Descargar reporte de similitud"}
          </button>
        </div>
      </div>

      {!canExport && (
        <p className="report-export-note">
          La exportación estará disponible cuando el documento tenga texto
          extraído.
        </p>
      )}
      {message && <p className="report-export-note" role="status">{message}</p>}
      {canExport && analyses.isPending && (
        <p className="report-export-note" role="status">
          Buscando análisis completados…
        </p>
      )}
      {analyses.isError && (
        <p className="report-export-error" role="alert">
          No se pudieron cargar los análisis: {errorMessage(analyses.error)}
        </p>
      )}
      {canExport &&
        !analyses.isPending &&
        !analyses.isError &&
        completedRuns.length === 0 && (
          <p className="report-export-note">
            Completa un análisis de IA para habilitar su reporte.
          </p>
        )}
      {reports.isError && (
        <p className="report-export-error" role="alert">
          No se pudo consultar el estado de los reportes:{" "}
          {errorMessage(reports.error)}
        </p>
      )}
      {generate.isError && (
        <p className="report-export-error" role="alert">
          No se pudo iniciar el reporte: {errorMessage(generate.error)}
        </p>
      )}
      {generateBoth.isError && <p className="report-export-error" role="alert">No se pudieron generar ambos reportes: {errorMessage(generateBoth.error)}</p>}
      {download.isError && (
        <p className="report-export-error" role="alert">
          No se pudo descargar el PDF: {errorMessage(download.error)}
        </p>
      )}
      {remove.isError && <p className="report-export-error" role="alert">No se pudo eliminar el PDF del reporte.</p>}
      {regenerate.isError && <p className="report-export-error" role="alert">No se pudo regenerar el reporte. La corrida original debe seguir disponible.</p>}

      {aiReports.length > 0 && (
        <ul
          className="report-artifact-list"
          aria-label="Reportes de IA de esta versión"
        >
          {aiReports.map((report) => (
            <li key={report.id}>
              <div>
                <strong>{reportVariantLabel(report.type)}</strong>
                <small>{report.filename}</small>
                <small>{report.documentName ?? "Documento original"} · Corrida {report.analysisRunId?.slice(0, 8) ?? "—"} · Señal {reportScoreLabel(report.run?.globalScore)} · {reportModelLabel(report)}</small>
                <span
                  className={`report-artifact-status is-${report.status.toLowerCase()}`}
                >
                  {reportStatusLabel(report)}
                </span>
                {report.status === "AVAILABLE" && (
                  <small>
                    Disponible por 24 h · Expira:{" "}
                    {expiryLabel(report.expiresAt)}
                    {expiryHint(report) && <span className="report-expiry-hint"> · {expiryHint(report)}</span>}
                  </small>
                )}
                {report.status === "EXPIRED" && (
                  <small>
                    El PDF expiró; el análisis se conserva y puedes regenerarlo.
                  </small>
                )}
                {report.status === "FAILED" || report.status === "ERROR" ? (
                  <small>{report.failureReason ?? "No se pudo generar el PDF. Intenta de nuevo."}</small>
                ) : null}
                <small>{report.sizeBytes == null ? "Tamaño no disponible" : `PDF · ${(report.sizeBytes / 1024).toFixed(report.sizeBytes < 1024 * 1024 ? 0 : 1)} ${report.sizeBytes < 1024 * 1024 ? "KB" : "MB"}`}</small>
              </div>
              <div className="report-row-actions">
                {report.status === "AVAILABLE" && <button className="button button-quiet" type="button" onClick={() => setPreviewReportId(report.id)}>Ver {reportVariantLabel(report.type).toLowerCase()}</button>}
                {report.status === "AVAILABLE" && <button className="button button-quiet" type="button" onClick={() => download.mutate(report)} disabled={download.isPending} aria-busy={download.isPending && download.variables?.id === report.id}>{download.isPending && download.variables?.id === report.id ? "Descargando…" : `Descargar ${reportVariantLabel(report.type).toLowerCase()}`}</button>}
                {report.status !== "GENERATING" && <button className="button button-quiet" type="button" onClick={() => regenerate.mutate(report.id)} disabled={generationPending}>Regenerar</button>}
                {report.status !== "DELETED" && <button className="button button-quiet button-danger-quiet" type="button" onClick={() => { if (window.confirm("Se eliminará el archivo PDF. El análisis seguirá disponible.")) remove.mutate(report.id); }} disabled={remove.isPending || report.status === "GENERATING"}>Eliminar</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {previewReportId && <ReportDetailPanel reportId={previewReportId} onClose={() => setPreviewReportId(null)} />}
    </section>
  );
}
