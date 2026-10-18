import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  listTurnitinReports,
  matchTurnitinReport,
  turnitinQueryKeys,
} from "../../api/turnitin";
import {
  deleteDocument,
  documentQueryKeys,
  getDocument,
  getDocumentPages,
  getDocumentText,
  processDocumentOcr,
  reprocessDocument,
} from "../../api/documents";
import { Icon } from "../../components/Icon";
import { AnalysisPanel } from "../analysis/AnalysisPanel";
import { ReportExportPanel } from "./ReportExportPanel";
import { ApiErrorNotice } from "./ApiErrorNotice";
import {
  formatBytes,
  formatDate,
  statusClass,
  statusLabel,
} from "./document-utils";

const processingStatuses = new Set(["UPLOADED", "PROCESSING"]);

export function DocumentDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showFullText, setShowFullText] = useState(false);
  const [selectedTurnitinReportId, setSelectedTurnitinReportId] = useState("");
  const [activeTab, setActiveTab] = useState<"document" | "analysis">(
    "analysis",
  );
  const [analysisMode, setAnalysisMode] = useState<"research" | "f005">(
    "research",
  );

  const document = useQuery({
    queryKey: documentQueryKeys.detail(id),
    queryFn: () => getDocument(id),
    enabled: Boolean(id),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data && processingStatuses.has(query.state.data.status)
        ? 2000
        : false,
  });

  const text = useQuery({
    queryKey: documentQueryKeys.text(id),
    queryFn: () => getDocumentText(id),
    enabled:
      Boolean(id) && showFullText && document.data?.status === "EXTRACTED",
    retry: 1,
  });

  const pages = useQuery({
    queryKey: documentQueryKeys.pages(id),
    queryFn: () => getDocumentPages(id),
    enabled: Boolean(id) && (document.data?.pageCount ?? 0) > 0,
    retry: 1,
  });

  const turnitinReports = useQuery({
    queryKey: turnitinQueryKeys.list(1, 100),
    queryFn: () => listTurnitinReports(1, 100),
    enabled: Boolean(id),
    retry: 1,
  });

  const reprocess = useMutation({
    mutationFn: () => reprocessDocument(id),
    onSuccess: (updated) => {
      queryClient.setQueryData(documentQueryKeys.detail(id), updated);
      void queryClient.invalidateQueries({ queryKey: documentQueryKeys.all });
    },
  });

  const processOcr = useMutation({
    mutationFn: () => processDocumentOcr(id),
    onSuccess: (result) => {
      queryClient.setQueryData(documentQueryKeys.detail(id), result.document);
      void queryClient.invalidateQueries({ queryKey: documentQueryKeys.all });
      void queryClient.invalidateQueries({
        queryKey: documentQueryKeys.text(id),
      });
      void queryClient.invalidateQueries({
        queryKey: documentQueryKeys.pages(id),
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteDocument(id),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: documentQueryKeys.detail(id) });
      queryClient.removeQueries({ queryKey: documentQueryKeys.text(id) });
      void queryClient.invalidateQueries({ queryKey: documentQueryKeys.all });
      navigate("/documents", { replace: true });
    },
  });

  const matchReport = useMutation({
    mutationFn: () =>
      matchTurnitinReport(
        selectedTurnitinReportId,
        record?.documentVersionId ?? "",
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(turnitinQueryKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({
        queryKey: turnitinQueryKeys.list(1, 100),
      });
      void queryClient.invalidateQueries({ queryKey: turnitinQueryKeys.all });
    },
  });

  function confirmDelete() {
    const name = document.data?.originalName ?? "este documento";
    if (
      window.confirm(`¿Eliminar “${name}”? Esta acción no se puede deshacer.`)
    )
      remove.mutate();
  }

  const record = document.data;
  const canReprocess = record?.status === "FAILED";
  const isProcessing = Boolean(record && processingStatuses.has(record.status));
  const turnitinItems = turnitinReports.data?.items ?? [];
  const attachedTurnitinReports = record?.documentVersionId
    ? turnitinItems.filter(
        (item) => item.documentVersionId === record.documentVersionId,
      )
    : [];
  const attachableTurnitinReports = turnitinItems.filter(
    (item) =>
      !item.documentVersionId ||
      item.documentVersionId === record?.documentVersionId,
  );
  const documentWorkflowStatus = processOcr.isPending
    ? "OCR_PROCESSING"
    : record?.status === "EXTRACTED"
      ? "READY"
      : record?.status === "OCR_REQUIRED"
        ? "OCR_REQUIRED"
        : record?.status === "FAILED"
          ? "ERROR"
          : "PROCESSING";

  return (
    <div className="dashboard-main document-detail-main">
      <header className="document-header">
        <div className="page-heading document-detail-heading">
          <div className="document-heading-copy">
            <nav
              className="document-breadcrumbs"
              aria-label="Ruta del documento"
            >
              <Link to="/documents">Documentos</Link>
              <span aria-hidden="true">/</span>
              <span>{record ? record.extension.toUpperCase() : "Detalle"}</span>
            </nav>
            <h1>
              {record?.originalName ||
                (document.isPending ? "Cargando documento…" : "Documento")}
            </h1>
            {record ? (
              <p className="document-header-meta">
                <span
                  className={`document-status-inline ${statusClass(record.status)}`}
                >
                  {statusLabel(record.status)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{formatBytes(record.sizeBytes)}</span>
                {record.wordCount !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {record.wordCount.toLocaleString("es-PE")} palabras
                    </span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>Actualizado {formatDate(record.updatedAt)}</span>
              </p>
            ) : (
              <p className="page-subtitle">
                Metadatos y análisis para este archivo.
              </p>
            )}
          </div>
          <div className="document-detail-actions">
            <Link className="button button-quiet" to="/documents">
              <Icon name="arrow-right" size={15} className="back-arrow" />
              <span>Todos los documentos</span>
            </Link>
            {record?.status === "OCR_REQUIRED" && (
              <button
                className="button button-primary"
                type="button"
                onClick={() => processOcr.mutate()}
                disabled={processOcr.isPending}
                aria-busy={processOcr.isPending}
              >
                <Icon
                  name="refresh"
                  size={15}
                  className={processOcr.isPending ? "is-spinning" : undefined}
                />
                <span>
                  {processOcr.isPending ? "Procesando OCR…" : "Procesar OCR"}
                </span>
              </button>
            )}
            {record && canReprocess && (
              <button
                className="button button-primary"
                type="button"
                onClick={() => reprocess.mutate()}
                disabled={reprocess.isPending}
                aria-busy={reprocess.isPending}
              >
                <Icon
                  name="refresh"
                  size={15}
                  className={reprocess.isPending ? "is-spinning" : undefined}
                />
                <span>
                  {reprocess.isPending ? "Reprocesando…" : "Reprocesar"}
                </span>
              </button>
            )}
            {record && (
              <button
                className="button button-danger-quiet"
                type="button"
                onClick={confirmDelete}
                disabled={remove.isPending}
              >
                <span>{remove.isPending ? "Eliminando…" : "Eliminar"}</span>
              </button>
            )}
          </div>
        </div>

        {record && (
          <div className="document-nav-bar">
            <nav
              className="document-detail-tabs"
              aria-label="Secciones del documento"
            >
              <button
                className={activeTab === "analysis" ? "is-active" : ""}
                type="button"
                aria-pressed={activeTab === "analysis"}
                onClick={() => setActiveTab("analysis")}
              >
                Análisis de investigación
              </button>
              <button
                className={activeTab === "document" ? "is-active" : ""}
                type="button"
                aria-pressed={activeTab === "document"}
                onClick={() => setActiveTab("document")}
              >
                Documento y extracción
              </button>
            </nav>
            {activeTab === "analysis" && (
              <div
                className="analysis-mode-switch"
                aria-label="Flujo de análisis"
              >
                <button
                  className={analysisMode === "research" ? "is-active" : ""}
                  type="button"
                  aria-pressed={analysisMode === "research"}
                  onClick={() => setAnalysisMode("research")}
                >
                  Research · experimental
                </button>
                <button
                  className={analysisMode === "f005" ? "is-active" : ""}
                  type="button"
                  aria-pressed={analysisMode === "f005"}
                  onClick={() => setAnalysisMode("f005")}
                >
                  F005 existente
                </button>
              </div>
            )}
          </div>
        )}
      </header>

      {document.isError && (
        <ApiErrorNotice
          error={document.error}
          title="No se pudo cargar el documento"
        />
      )}
      {reprocess.isError && (
        <ApiErrorNotice
          error={reprocess.error}
          title="No se pudo reprocesar el documento"
        />
      )}
      {processOcr.isError && (
        <ApiErrorNotice
          error={processOcr.error}
          title="No se pudo procesar el OCR"
        />
      )}
      {remove.isError && (
        <ApiErrorNotice
          error={remove.error}
          title="No se pudo eliminar el documento"
        />
      )}
      {matchReport.isError && (
        <ApiErrorNotice
          error={matchReport.error}
          title="No se pudo vincular el reporte Turnitin"
        />
      )}

      {document.isPending && (
        <div className="documents-empty-state" role="status" aria-live="polite">
          <span className="state-indicator is-animated" />
          <span>Cargando los metadatos…</span>
        </div>
      )}

      {record && activeTab === "document" && (
        <div className="document-extraction-view">
          {(isProcessing ||
            record.status === "OCR_REQUIRED" ||
            (record.status === "FAILED" && record.extractionError) ||
            processOcr.isPending ||
            record.ocrStatus === "PARTIAL" ||
            record.averageOcrConfidence !== null) && (
            <section
              className="document-status-strip"
              aria-label="Estado del procesamiento"
            >
              {isProcessing && (
                <p className="processing-inline" role="status">
                  <span className="state-indicator is-animated" /> El backend
                  está procesando el archivo. Esta vista se actualizará
                  automáticamente.
                </p>
              )}
              {record.status === "OCR_REQUIRED" && (
                <p className="document-warning-note">
                  Este documento necesita OCR local para recuperar texto de las
                  páginas escaneadas.
                </p>
              )}
              {record.status === "FAILED" && record.extractionError && (
                <p className="document-error-note">
                  <strong>Error de extracción:</strong> {record.extractionError}
                </p>
              )}
              {processOcr.isPending && (
                <p className="processing-inline" role="status">
                  <span className="state-indicator is-animated" /> Procesando
                  OCR página por página, sin porcentaje estimado.
                </p>
              )}
              {record.ocrStatus === "PARTIAL" && (
                <p className="document-warning-note">
                  El OCR quedó parcial. Revisa los avisos y las páginas que aún
                  requieren procesamiento.
                </p>
              )}
              {record.averageOcrConfidence !== null && (
                <p className="document-success-note">
                  Confianza promedio OCR:{" "}
                  {(record.averageOcrConfidence * 100).toFixed(1)} %.
                </p>
              )}
            </section>
          )}

          {record.warnings.length > 0 && (
            <section
              className="document-warnings"
              aria-labelledby="document-warnings-title"
            >
              <h2 id="document-warnings-title">Avisos del procesamiento</h2>
              <ul>
                {record.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="document-detail-grid">
            <section
              className="document-panel metadata-panel"
              aria-labelledby="metadata-title"
            >
              <div className="document-panel-heading">
                <div>
                  <p className="eyebrow">INFORMACIÓN DEL ARCHIVO</p>
                  <h2 id="metadata-title">Metadatos</h2>
                </div>
              </div>
              <dl className="metadata-list">
                <div>
                  <dt>Nombre original</dt>
                  <dd>{record.originalName}</dd>
                </div>
                <div>
                  <dt>Estado</dt>
                  <dd>
                    {statusLabel(record.status)}
                    {record.ocrStatus === "COMPLETED"
                      ? " · OCR completado"
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Formato</dt>
                  <dd>
                    {record.extension.toUpperCase()}{" "}
                    <span className="metadata-secondary">
                      ({record.mimeType || "tipo no indicado"})
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Tamaño</dt>
                  <dd>{formatBytes(record.sizeBytes)}</dd>
                </div>
                <div>
                  <dt>Páginas</dt>
                  <dd>
                    {record.pageCount ??
                      (record.extension === "pdf" ? "Pendiente" : "No aplica")}
                  </dd>
                </div>
                <div>
                  <dt>Palabras</dt>
                  <dd>
                    {record.wordCount?.toLocaleString("es-PE") ?? "Pendiente"}
                  </dd>
                </div>
                <div>
                  <dt>Caracteres</dt>
                  <dd>
                    {record.characterCount?.toLocaleString("es-PE") ??
                      "Pendiente"}
                  </dd>
                </div>
                <div>
                  <dt>Subido</dt>
                  <dd>
                    <time dateTime={record.createdAt}>
                      {formatDate(record.createdAt)}
                    </time>
                  </dd>
                </div>
                <div className="metadata-hash">
                  <dt>SHA-256</dt>
                  <dd title={record.sha256}>{record.sha256}</dd>
                </div>
                <div>
                  <dt>OCR</dt>
                  <dd>{record.requiresOcr ? "Requerido" : "No requerido"}</dd>
                </div>
              </dl>
            </section>

            <section
              className="document-panel preview-panel"
              aria-labelledby="preview-title"
            >
              <div className="document-panel-heading preview-heading">
                <div>
                  <p className="eyebrow">CONTENIDO EXTRAÍDO</p>
                  <h2 id="preview-title">Vista previa</h2>
                </div>
                {record.status === "EXTRACTED" && (
                  <button
                    className="button button-quiet"
                    type="button"
                    onClick={() => setShowFullText((value) => !value)}
                    aria-expanded={showFullText}
                  >
                    {showFullText
                      ? "Ocultar texto completo"
                      : "Cargar texto completo"}
                  </button>
                )}
              </div>

              {record.textPreview ? (
                <div className="document-preview-text">
                  {record.textPreview}
                </div>
              ) : (
                <div className="document-preview-empty">
                  {record.status === "EXTRACTED"
                    ? "El backend no devolvió una vista previa para este documento."
                    : "La vista previa aparecerá cuando termine la extracción del texto."}
                </div>
              )}

              {showFullText && (
                <div className="full-text-region">
                  {text.isPending && (
                    <p className="full-text-status" role="status">
                      Cargando texto completo…
                    </p>
                  )}
                  {text.isError && (
                    <ApiErrorNotice
                      error={text.error}
                      title="No se pudo cargar el texto completo"
                    />
                  )}
                  {text.data && (
                    <>
                      <p className="full-text-meta">
                        {text.data.wordCount.toLocaleString("es-PE")} palabras ·{" "}
                        {text.data.characterCount.toLocaleString("es-PE")}{" "}
                        caracteres
                      </p>
                      <div className="document-full-text">
                        {text.data.text || "No se encontró texto extraído."}
                      </div>
                    </>
                  )}
                </div>
              )}
            </section>
          </div>

          {record.pageCount !== null && record.pageCount > 0 && (
            <section
              className="document-panel"
              aria-labelledby="document-pages-title"
            >
              <div className="document-panel-heading">
                <div>
                  <p className="eyebrow">RECONSTRUCCIÓN POR PÁGINA</p>
                  <h2 id="document-pages-title">Páginas</h2>
                </div>
              </div>
              {pages.isError && (
                <ApiErrorNotice
                  error={pages.error}
                  title="No se pudieron cargar las páginas"
                />
              )}
              {pages.data && (
                <ol className="document-page-list">
                  {pages.data.items.map((page) => (
                    <li key={page.pageNumber}>
                      <strong>Página {page.pageNumber}</strong>
                      <span>{page.extractionMethod}</span>
                      <small>
                        {page.wordCount.toLocaleString("es-PE")} palabras ·{" "}
                        {page.characterCount.toLocaleString("es-PE")} caracteres
                        {page.ocrConfidence !== null
                          ? ` · ${(page.ocrConfidence * 100).toFixed(1)} % confianza`
                          : ""}
                      </small>
                      {page.requiresOcr && <small>OCR pendiente</small>}
                      {(page.lowConfidenceCount ?? 0) > 0 && (
                        <small>
                          Algunos fragmentos pueden contener errores de
                          reconocimiento.
                        </small>
                      )}
                      {page.warnings.map((warning, index) => (
                        <small key={`${warning}-${index}`}>{warning}</small>
                      ))}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}

          <section
            className="document-panel turnitin-attachment-panel"
            aria-labelledby="attached-turnitin-title"
          >
            <div className="document-panel-heading">
              <div>
                <p className="eyebrow">F002 · GROUND TRUTH</p>
                <h2 id="attached-turnitin-title">
                  Reportes Turnitin vinculados
                </h2>
              </div>
            </div>
            <p className="turnitin-attachment-copy">
              La asociación compara el texto del reporte con la versión extraída
              del documento y registra también conteos y metadatos visibles.
            </p>
            {turnitinReports.isError && (
              <ApiErrorNotice
                error={turnitinReports.error}
                title="No se pudieron cargar los reportes Turnitin"
              />
            )}
            {attachedTurnitinReports.length > 0 ? (
              <ul className="turnitin-attached-list">
                {attachedTurnitinReports.map((item) => (
                  <li key={item.id}>
                    <span>
                      <strong>{item.originalName}</strong>
                      <small>
                        {item.reportType} · {item.contentMatchStatus}
                        {item.contentSimilarityRatio !== null
                          ? ` · ${(item.contentSimilarityRatio * 100).toFixed(1)}%`
                          : ""}
                      </small>
                    </span>
                    <Link
                      className="button button-quiet"
                      to={`/turnitin-reports/${item.id}`}
                    >
                      Abrir reporte
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              !turnitinReports.isPending && (
                <p className="turnitin-no-reports">
                  Todavía no hay reportes vinculados a esta versión.
                </p>
              )
            )}
            {record.documentVersionId &&
              record.status === "EXTRACTED" &&
              attachableTurnitinReports.length > 0 && (
                <div className="turnitin-attach-row">
                  <label>
                    <span>Selecciona un reporte para comparar</span>
                    <select
                      value={selectedTurnitinReportId}
                      onChange={(event) =>
                        setSelectedTurnitinReportId(event.currentTarget.value)
                      }
                    >
                      <option value="">Seleccionar reporte</option>
                      {attachableTurnitinReports.map((item) => (
                        <option value={item.id} key={item.id}>
                          {item.originalName} · {item.reportType}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button button-primary"
                    type="button"
                    onClick={() => matchReport.mutate()}
                    disabled={
                      !selectedTurnitinReportId || matchReport.isPending
                    }
                    aria-busy={matchReport.isPending}
                  >
                    {matchReport.isPending
                      ? "Comparando…"
                      : "Vincular y comparar"}
                  </button>
                </div>
              )}
            {record.status !== "EXTRACTED" && (
              <p className="turnitin-caution">
                La comparación estará disponible cuando la extracción del
                documento termine.
              </p>
            )}
            {turnitinReports.data?.items.length === 0 && (
              <p className="turnitin-caution">
                <Link to="/turnitin-reports">Importa un reporte Turnitin</Link>{" "}
                para vincularlo a este documento.
              </p>
            )}
          </section>
        </div>
      )}

      {record && activeTab === "analysis" && (
        <>
          <AnalysisPanel
            key={`${id}:${analysisMode}`}
            documentId={id}
            fileName={record.originalName}
            hasText={
              record.status === "EXTRACTED" && (record.characterCount ?? 0) > 0
            }
            researchMode={analysisMode === "research"}
            documentWorkflowStatus={documentWorkflowStatus}
          />
          <ReportExportPanel
            documentId={id}
            documentVersionId={record.documentVersionId ?? null}
            canExport={
              record.status === "EXTRACTED" && (record.characterCount ?? 0) > 0
            }
          />
        </>
      )}
    </div>
  );
}
