import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../../api/client";
import { analysisQueryKeys, listDocumentAnalyses } from "../../api/analysis";
import {
  downloadReport,
  deleteReport,
  generateAIReport,
  listDocumentReports,
  regenerateReport,
  reportQueryKeys,
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
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
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
    completedRuns.find((run) => run.id === selectedRunId) ?? completedRuns[0];

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

  const currentReports = reports.data?.items ?? [];
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

  return (
    <section
      className="document-panel report-export-panel"
      aria-labelledby="report-export-title"
    >
      <div className="document-panel-heading">
        <div>
          <p className="eyebrow">EXPORTACIÓN</p>
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
      <div className="report-export-actions">
        <div className="report-export-action">
          <div>
            <h3>Revisión sobre documento original</h3>
            <p>
              Conserva la maquetación del archivo y señala los párrafos que
              alcanzan el umbral aplicado.
            </p>
          </div>
          {selectedOriginalReport?.status === "AVAILABLE" ? (
            <div className="report-row-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => setSelectedReportId(selectedOriginalReport.id)}
              >
                Ver revisión original
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => download.mutate(selectedOriginalReport)}
                disabled={download.isPending}
              >
                Descargar revisión original
              </button>
            </div>
          ) : (
            <button
              className="button button-primary"
              type="button"
              onClick={() =>
                selectedRun &&
                generate.mutate({
                  runId: selectedRun.id,
                  variant: "AI_ORIGINAL_REVIEW",
                })
              }
              disabled={
                !canExport ||
                !selectedRun ||
                generate.isPending ||
                selectedOriginalReport?.status === "GENERATING"
              }
              aria-busy={
                generate.isPending ||
                selectedOriginalReport?.status === "GENERATING"
              }
            >
              {generate.isPending ||
              selectedOriginalReport?.status === "GENERATING"
                ? "Generando…"
                : selectedOriginalReport
                  ? "Regenerar revisión original"
                  : "Generar revisión original"}
            </button>
          )}
        </div>

        <div className="report-export-action">
          <div>
            <h3>Detalle técnico por párrafos</h3>
            <p>
              Muestra el score local, el umbral, el estado, las exclusiones y
              el texto completo de cada segmento.
            </p>
          </div>
          {selectedTechnicalReport?.status === "AVAILABLE" ? (
            <div className="report-row-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => setSelectedReportId(selectedTechnicalReport.id)}
              >
                Ver detalle por párrafos
              </button>
              <button
                className="button button-quiet"
                type="button"
                onClick={() => download.mutate(selectedTechnicalReport)}
                disabled={download.isPending}
              >
                Descargar detalle por párrafos
              </button>
            </div>
          ) : (
            <button
              className="button button-primary"
              type="button"
              onClick={() =>
                selectedRun &&
                generate.mutate({
                  runId: selectedRun.id,
                  variant: "AI_PARAGRAPH_TECHNICAL",
                })
              }
              disabled={
                !canExport ||
                !selectedRun ||
                generate.isPending ||
                selectedTechnicalReport?.status === "GENERATING"
              }
              aria-busy={
                generate.isPending ||
                selectedTechnicalReport?.status === "GENERATING"
              }
            >
              {generate.isPending ||
              selectedTechnicalReport?.status === "GENERATING"
                ? "Generando…"
                : selectedTechnicalReport
                  ? "Regenerar detalle por párrafos"
                  : "Generar detalle por párrafos"}
            </button>
          )}
        </div>

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
                {report.status === "AVAILABLE" && <button className="button button-quiet" type="button" onClick={() => setSelectedReportId(report.id)}>Ver {reportVariantLabel(report.type).toLowerCase()}</button>}
                {report.status === "AVAILABLE" && <button className="button button-quiet" type="button" onClick={() => download.mutate(report)} disabled={download.isPending} aria-busy={download.isPending && download.variables?.id === report.id}>{download.isPending && download.variables?.id === report.id ? "Descargando…" : `Descargar ${reportVariantLabel(report.type).toLowerCase()}`}</button>}
                {["EXPIRED", "DELETED", "FAILED", "ERROR"].includes(report.status) && <button className="button button-quiet" type="button" onClick={() => regenerate.mutate(report.id)} disabled={regenerate.isPending}>Regenerar</button>}
                {report.status !== "DELETED" && <button className="button button-quiet button-danger-quiet" type="button" onClick={() => { if (window.confirm("Se eliminará el archivo PDF. El análisis seguirá disponible.")) remove.mutate(report.id); }} disabled={remove.isPending || report.status === "GENERATING"}>Eliminar</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {selectedReportId && <ReportDetailPanel reportId={selectedReportId} onClose={() => setSelectedReportId(null)} />}
    </section>
  );
}
