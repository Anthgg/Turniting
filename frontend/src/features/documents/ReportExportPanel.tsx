import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../../api/client";
import { analysisQueryKeys, listDocumentAnalyses } from "../../api/analysis";
import {
  downloadReport,
  generateAIReport,
  listDocumentReports,
  reportQueryKeys,
  type ReportArtifact,
} from "../../api/reports";

function expiryLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "fecha no disponible";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function reportStatusLabel(report: ReportArtifact): string {
  switch (report.status) {
    case "GENERATING":
      return "Generando…";
    case "AVAILABLE":
      return "Disponible";
    case "EXPIRED":
      return "Expirado";
    case "ERROR":
      return "Error al generar";
    case "DELETED":
      return "Eliminado";
  }
}

export function ReportExportPanel({
  documentId,
  documentVersionId,
  canExport,
}: {
  documentId: string;
  documentVersionId: string | null;
  canExport: boolean;
}) {
  const queryClient = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState("");
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
    mutationFn: (runId: string) => generateAIReport(documentId, runId),
    onSuccess: async () => {
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

  const currentReports = (reports.data?.items ?? []).filter(
    (report) =>
      !documentVersionId || report.documentVersionId === documentVersionId,
  );
  const aiReports = currentReports.filter(
    (report) => report.type === "AI_REPORT",
  );
  const latestAIReport = aiReports[0];
  const availableSimilarity = currentReports.find(
    (report) =>
      report.type === "SIMILARITY_REPORT" &&
      report.status === "AVAILABLE" &&
      report.similarityRunId,
  );
  const generateLabel =
    latestAIReport?.status === "EXPIRED" || latestAIReport?.status === "DELETED"
      ? "Regenerar reporte IA"
      : latestAIReport?.status === "ERROR"
        ? "Reintentar reporte IA"
        : "Generar reporte IA";
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
      <div className="report-export-actions">
        <div className="report-export-action">
          <div>
            <h3>Reporte independiente de IA</h3>
            <p>
              Se genera desde una corrida completada de esta versión del
              documento.
            </p>
          </div>
          {completedRuns.length > 1 && (
            <label className="report-run-select">
              <span>Corrida</span>
              <select
                value={selectedRun?.id ?? ""}
                onChange={(event) =>
                  setSelectedRunId(event.currentTarget.value)
                }
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
          <button
            className="button button-primary"
            type="button"
            onClick={() => selectedRun && generate.mutate(selectedRun.id)}
            disabled={
              !canExport ||
              !selectedRun ||
              generate.isPending ||
              latestAIReport?.status === "GENERATING"
            }
            aria-busy={
              generate.isPending || latestAIReport?.status === "GENERATING"
            }
          >
            {generate.isPending || latestAIReport?.status === "GENERATING"
              ? "Generando…"
              : generateLabel}
          </button>
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

      {aiReports.length > 0 && (
        <ul
          className="report-artifact-list"
          aria-label="Reportes de IA de esta versión"
        >
          {aiReports.map((report) => (
            <li key={report.id}>
              <div>
                <strong>{report.filename}</strong>
                <span
                  className={`report-artifact-status is-${report.status.toLowerCase()}`}
                >
                  {reportStatusLabel(report)}
                </span>
                {report.status === "AVAILABLE" && (
                  <small>
                    Disponible por 24 h · Expira:{" "}
                    {expiryLabel(report.expiresAt)}
                  </small>
                )}
                {report.status === "EXPIRED" && (
                  <small>
                    El PDF expiró; el análisis se conserva y puedes regenerarlo.
                  </small>
                )}
              </div>
              {report.status === "AVAILABLE" && (
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => download.mutate(report)}
                  disabled={download.isPending}
                  aria-busy={
                    download.isPending && download.variables?.id === report.id
                  }
                >
                  {download.isPending && download.variables?.id === report.id
                    ? "Descargando…"
                    : "Descargar PDF"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
