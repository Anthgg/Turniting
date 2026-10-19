import { useQuery } from "@tanstack/react-query";
import {
  getReportDetail,
  reportPreviewUrl,
  reportQueryKeys,
} from "../../api/reports";

function dateLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No disponible";
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function scoreLabel(score: number | null | undefined) {
  return typeof score === "number" ? `${Math.round(score * 100)} %` : "No disponible";
}

export function ReportDetailPanel({
  reportId,
  onClose,
}: {
  reportId: string;
  onClose: () => void;
}) {
  const detail = useQuery({
    queryKey: reportQueryKeys.detail(reportId),
    queryFn: () => getReportDetail(reportId),
    retry: 1,
  });
  const isOriginalReview = detail.data?.type === "AI_ORIGINAL_REVIEW";
  const isTechnicalReport = detail.data?.type === "AI_PARAGRAPH_TECHNICAL";
  const reportTitle = isOriginalReview
    ? "Revisión original"
    : isTechnicalReport
      ? "Detalle por párrafos"
      : "Detalle del reporte";
  const reportEyebrow = isOriginalReview
    ? "REVISIÓN SOBRE EL DOCUMENTO ORIGINAL"
    : isTechnicalReport
      ? "DETALLE TÉCNICO POR PÁRRAFOS"
      : "METADATOS DEL PDF";

  return (
    <section className="report-detail-panel" aria-labelledby="report-detail-title">
      <div className="report-detail-heading">
        <div>
          <p className="eyebrow">{reportEyebrow}</p>
          <h2 id="report-detail-title">{reportTitle}</h2>
        </div>
        <button className="button button-quiet" type="button" onClick={onClose}>
          Cerrar
        </button>
      </div>
      {detail.isPending && <p role="status">Cargando los metadatos…</p>}
      {detail.isError && <p className="report-export-error" role="alert">No se pudieron cargar los metadatos del reporte.</p>}
      {detail.data && (
        <dl className="report-detail-grid">
          <div><dt>ID corto</dt><dd title={detail.data.id}>{detail.data.id.slice(0, 8)}</dd></div>
          <div><dt>Documento</dt><dd>{detail.data.documentName}</dd></div>
          <div><dt>DocumentVersion</dt><dd title={detail.data.documentVersionId}>{detail.data.documentVersionId.slice(0, 8)}</dd></div>
          <div><dt>AnalysisRun</dt><dd title={detail.data.analysisRunId ?? undefined}>{detail.data.analysisRunId?.slice(0, 8) ?? "No disponible"}</dd></div>
          <div><dt>Modelo</dt><dd>{detail.data.run?.modelNames.join(" + ") || detail.data.run?.analyzerMode || "No disponible"}</dd></div>
          <div><dt>Profile</dt><dd>{detail.data.run?.thresholdProfile ?? "No disponible"}</dd></div>
          <div><dt>Paragraph mode</dt><dd>{detail.data.run?.paragraphMode ?? "No disponible"}</dd></div>
          <div><dt>Señal global estimada</dt><dd>{scoreLabel(detail.data.run?.globalScore)}</dd></div>
          <div><dt>Generado</dt><dd>{dateLabel(detail.data.generatedAt)}</dd></div>
          <div><dt>Expira</dt><dd>{dateLabel(detail.data.expiresAt)}</dd></div>
          <div><dt>Estado</dt><dd>{detail.data.status === "ERROR" ? "Error" : detail.data.status}</dd></div>
          <div><dt>Tamaño</dt><dd>{detail.data.sizeBytes == null ? "No disponible" : `${(detail.data.sizeBytes / 1024).toFixed(detail.data.sizeBytes < 1024 * 1024 ? 0 : 1)} ${detail.data.sizeBytes < 1024 * 1024 ? "KB" : "MB"}`}</dd></div>
          <div><dt>Hash de contenido</dt><dd title={detail.data.contentHash ?? undefined}>{detail.data.contentHash?.slice(0, 12) ?? "No disponible"}</dd></div>
          <div><dt>Renderer version</dt><dd>{detail.data.generationVersion ?? "No disponible"}</dd></div>
          {detail.data.failureReason && <div><dt>Detalle del error</dt><dd>{detail.data.failureReason}</dd></div>}
        </dl>
      )}
      {detail.data?.status === "AVAILABLE" && detail.data.previewAvailable !== false && (
        <div className="report-preview-section">
          <div>
            <p className="eyebrow">VISTA PREVIA</p>
            <h3>PDF del reporte</h3>
          </div>
          <iframe
            className="report-preview-frame"
            src={reportPreviewUrl(reportId)}
            title={`Vista previa: ${detail.data.filename}`}
          />
        </div>
      )}
    </section>
  );
}
