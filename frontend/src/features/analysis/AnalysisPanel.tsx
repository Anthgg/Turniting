import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ANALYZERS,
  ANALYSIS_SEGMENT_FILTERS,
  PARAGRAPH_MODES,
  THRESHOLD_PROFILES,
  analysisQueryKeys,
  analyzeDocument,
  getAnalysisSegments,
  listAnalyzerModels,
  listDocumentAnalyses,
  type AnalysisSegmentFilter,
  type AnalysisSegmentSort,
  type AnalyzerName,
  type ParagraphModeName,
  type ThresholdProfileName,
} from "../../api/analysis";
import { ApiRequestError } from "../../api/client";
import { Icon } from "../../components/Icon";
import {
  ANALYZER_LABEL,
  DEFAULT_PARAGRAPH_MODE,
  PROFILE_LABEL,
  SIGNAL_LABEL,
  analysisErrorMessage,
  availabilityLabel,
  formatPercent,
  formatPercentPoints,
  formatSignal,
  isAnalyzerUsable,
  operationErrorMessage,
  segmentsBelongToRun,
  selectAnalysisRun,
  signalLevel,
  toDisplayPercent,
} from "./analysis-utils";

const MODEL_FOR_ANALYZER: Record<AnalyzerName, string> = {
  V3_ONLY: "CANDIDATE_MODEL_V3",
  V2_ONLY: "CANDIDATE_MODEL_V2",
  ENSEMBLE: "ENSEMBLE_V2_V3",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  RUNNING: "Analizando",
  COMPLETED: "Completado",
  FAILED: "Error",
};

function runDate(value: string) {
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function AnalysisPanel({
  documentId,
  fileName,
  hasText,
  researchMode = false,
  documentWorkflowStatus,
}: {
  documentId: string;
  fileName?: string;
  hasText: boolean;
  researchMode?: boolean;
  documentWorkflowStatus?: string;
}) {
  const queryClient = useQueryClient();
  const [analyzer, setAnalyzer] = useState<AnalyzerName>(
    researchMode ? "ENSEMBLE" : "V3_ONLY",
  );
  const [profile, setProfile] = useState<ThresholdProfileName>(
    researchMode ? "BALANCED" : "LOW_FALSE_POSITIVE",
  );
  const [mode, setMode] = useState<ParagraphModeName>(DEFAULT_PARAGRAPH_MODE);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [sort, setSort] = useState<AnalysisSegmentSort>("PARAGRAPH");
  const [filter, setFilter] = useState<AnalysisSegmentFilter>("ALL");
  const [page, setPage] = useState(1);
  const [expandedParagraphs, setExpandedParagraphs] = useState<
    Record<number, boolean>
  >({});

  const models = useQuery({
    queryKey: analysisQueryKeys.models(),
    queryFn: listAnalyzerModels,
    retry: 1,
  });
  const runs = useQuery({
    queryKey: analysisQueryKeys.documentAnalyses(documentId),
    queryFn: () => listDocumentAnalyses(documentId),
    retry: 1,
  });
  const history = runs.data?.items ?? [];
  const run = selectAnalysisRun(history, selectedRun);
  const runId = run?.id ?? null;
  const segmentQuery = researchMode
    ? { page, pageSize: 20, sort, filter }
    : undefined;
  const segments = useQuery({
    queryKey: analysisQueryKeys.segments(runId ?? "none", segmentQuery),
    queryFn: () => getAnalysisSegments(runId as string, segmentQuery),
    enabled: Boolean(runId && run?.status === "COMPLETED"),
    retry: 1,
  });

  const analyze = useMutation({
    mutationFn: () =>
      analyzeDocument(documentId, {
        analyzer,
        thresholdProfile: profile,
        paragraphMode: mode,
      }),
    onSuccess: async (result) => {
      setSelectedRun(result.id);
      setPage(1);
      setFilter("ALL");
      setExpandedParagraphs({});
      await queryClient.invalidateQueries({
        queryKey: analysisQueryKeys.documentAnalyses(documentId),
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: analysisQueryKeys.documentAnalyses(documentId),
      });
    },
  });

  const modelName = MODEL_FOR_ANALYZER[analyzer];
  const requiredModelNames =
    analyzer === "ENSEMBLE"
      ? [modelName, "CANDIDATE_MODEL_V2", "CANDIDATE_MODEL_V3"]
      : [modelName];
  const requiredModels = requiredModelNames.map((name) =>
    models.data?.items.find((item) => item.name === name),
  );
  const usable = requiredModels.every(
    (item) => item && item.servable && isAnalyzerUsable(item.availability),
  );
  const f006 = models.data?.items.find(
    (item) => item.name === "EXPERIMENTAL_F006_MODEL",
  );
  const analysisError = analyze.isError ? analyze.error : null;
  const historyError = runs.isError ? runs.error : null;
  const modelStatusError = models.isError ? models.error : null;
  const segmentsError = segments.isError ? segments.error : null;
  const segmentsMatchRun = segmentsBelongToRun(runId, segments.data);
  const paragraphItems = segmentsMatchRun ? segments.data?.items ?? [] : [];
  const totalParagraphs = segmentsMatchRun
    ? (segments.data?.total ?? paragraphItems.length)
    : 0;
  const pageCount = segmentsMatchRun ? (segments.data?.pages ?? 1) : 1;
  const runMetadata = run && isRecord(run.metadata) ? run.metadata : {};
  const cacheHitLabel =
    typeof runMetadata.cacheHit === "boolean"
      ? runMetadata.cacheHit
        ? "Sí"
        : "No"
      : "No registrado";
  const runScorePercent = run
    ? run.documentScorePercent === undefined
      ? toDisplayPercent(run.documentScore)
      : run.documentScorePercent
    : null;
  const workflowStatus = analyze.isPending
    ? "ANALYZING"
    : run?.status === "COMPLETED"
      ? "ANALYZED"
      : run?.status === "FAILED"
        ? "ERROR"
        : (documentWorkflowStatus ?? (hasText ? "READY" : "PROCESSING"));

  return (
    <section
      className={`document-panel analysis-panel${researchMode ? " research-analysis-panel" : ""}`}
      aria-labelledby="analysis-title"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">
            {researchMode
              ? "RESEARCH · EXPERIMENTAL · ANÁLISIS LOCAL"
              : "ANÁLISIS LOCAL · F005"}
          </p>
          <h2 id="analysis-title">Señal de participación de IA</h2>
        </div>
        <Link className="button button-quiet" to="/analysis/compare">
          Comparar versiones
        </Link>
      </div>
      <p className="analysis-disclaimer">
        Estimación de un modelo de investigación independiente. No es un puntaje
        de Turnitin, no prueba autoría y no debe usarse por sí sola para tomar
        decisiones sobre una persona.
      </p>
      {researchMode && (
        <div className="research-analyzer-notices">
          <p className="analysis-notice research-default-note">
            Configuración inicial: <strong>ENSEMBLE_V2_V3</strong>, perfil{" "}
            <strong>BALANCED</strong>, pesos V2/V3 de 0.5/0.5, párrafo estricto
            y agregación media ponderada por tokens. El puntaje mostrado es la
            probabilidad calibrada × 100.
          </p>
          <p className="analysis-notice research-f006-note" role="status">
            <strong>F006 experimental: no disponible para inferencia.</strong>{" "}
            {f006
              ? availabilityLabel(f006.availability)
              : "Este artefacto no está habilitado en el registro local."}
          </p>
          <p className="analysis-notice">
            Si el texto está en español, interpreta la señal con cautela: el
            modelo es experimental y puede equivocarse. Esta advertencia no
            bloquea el análisis.
          </p>
        </div>
      )}

      <div className="analysis-controls">
        <label>
          <span>Analizador</span>
          <select
            value={analyzer}
            onChange={(event) => {
              analyze.reset();
              setAnalyzer(event.currentTarget.value as AnalyzerName)
            }}
          >
            {ANALYZERS.map((item) => (
              <option key={item} value={item}>
                {item === "ENSEMBLE"
                  ? "ENSEMBLE_V2_V3 · V2 + V3"
                  : ANALYZER_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Perfil de umbral</span>
          <select
            value={profile}
            onChange={(event) => {
              analyze.reset();
              setProfile(event.currentTarget.value as ThresholdProfileName)
            }}
          >
            {THRESHOLD_PROFILES.map((item) => (
              <option key={item} value={item}>
                {PROFILE_LABEL[item]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Párrafos</span>
          <select
            value={mode}
            onChange={(event) => {
              analyze.reset();
              setMode(event.currentTarget.value as ParagraphModeName)
            }}
          >
            {PARAGRAPH_MODES.map((item) => (
              <option key={item} value={item}>
                {item === "STRICT_PARAGRAPH"
                  ? "Solo el párrafo"
                  : "Con contexto breve"}
              </option>
            ))}
          </select>
        </label>
        <button
          className="button button-primary"
          type="button"
          disabled={!hasText || analyze.isPending || !usable}
          onClick={() => analyze.mutate()}
          aria-busy={analyze.isPending}
        >
          <Icon name="spark" size={16} />
          <span>{analyze.isPending ? "Analizando…" : "Analizar IA"}</span>
        </button>
      </div>

      {researchMode && history.length > 0 && (
        <div className="analysis-history-controls">
          <label>
            <span>Historial de análisis</span>
            <select
              value={runId ?? ""}
              onChange={(event) => {
                analyze.reset();
                setSelectedRun(event.currentTarget.value);
                setPage(1);
                setExpandedParagraphs({});
              }}
            >
              {history.map((item) => (
                <option key={item.id} value={item.id}>
                  {runDate(item.createdAt)} ·{" "}
                  {ANALYZER_LABEL[item.analyzerMode]} ·{" "}
                  {PROFILE_LABEL[item.thresholdProfile] ??
                    item.thresholdProfile}
                  {" · "}
                  {item.documentScorePercent === undefined
                    ? formatSignal(item.documentScore)
                    : formatPercentPoints(item.documentScorePercent)} ·{" "}
                  {STATUS_LABEL[item.status] ?? item.status}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <ul className="analysis-model-status" aria-label="Estado de los modelos">
        {requiredModelNames.map((name) => {
          const item = models.data?.items.find((model) => model.name === name);
          return (
            <li key={name}>
              <strong>{name}</strong>
              <span>
                {item
                  ? availabilityLabel(item.availability)
                  : models.isError
                    ? "Sin conexión con la API"
                    : "Comprobando…"}
              </span>
            </li>
          );
        })}
      </ul>
      {modelStatusError && (
        <p className="analysis-notice" role="status">
          {operationErrorMessage("modelStatusError")} El análisis está
          deshabilitado hasta verificar su disponibilidad.
        </p>
      )}
      {!usable && models.data && (
        <p className="analysis-notice" role="status">
          El analizador {modelName} no está disponible. Revisa el artefacto
          registrado para ese modelo; las rutas locales no se muestran aquí.
        </p>
      )}
      {!hasText && (
        <p className="analysis-notice">
          El documento aún no tiene texto extraído listo. Completa la extracción
          u OCR antes de analizarlo.
        </p>
      )}
      {historyError && researchMode && (
        <p className="analysis-notice analysis-error" role="alert">
          {operationErrorMessage("historyError")} El resultado que ya está
          seleccionado permanece visible.
          <button className="button button-quiet" type="button" onClick={() => void runs.refetch()}>
            Reintentar historial
          </button>
        </p>
      )}
      {analysisError && (
        <p className="analysis-notice analysis-error" role="alert">
          {analysisError instanceof ApiRequestError
            ? analysisErrorMessage(analysisError.code, analysisError.status)
            : operationErrorMessage("analysisError")}
          <button className="button button-quiet" type="button" onClick={() => analyze.mutate()}>
            Reintentar análisis
          </button>
        </p>
      )}
      {analyze.isPending && (
        <p className="analysis-notice" role="status" aria-live="polite">
          Estado: ANALYZING · el análisis local está en curso, sin porcentaje
          estimado.
        </p>
      )}
      <p className="analysis-workflow-status" role="status">
        Estado del flujo: <strong>{workflowStatus}</strong>
      </p>

      {researchMode && fileName && (
        <p className="analysis-document-name">
          Documento: <strong>{fileName}</strong>
        </p>
      )}
      {run && (
        <div className="analysis-summary" aria-label="Resultado del análisis">
          <div>
            <span>Estado</span>
            <strong>{STATUS_LABEL[run.status] ?? run.status}</strong>
          </div>
          <div>
            <span>Run ID</span>
            <strong title={run.id}>{run.id.slice(0, 8)}</strong>
          </div>
          <div>
            <span>Fecha</span>
            <strong>{runDate(run.createdAt)}</strong>
          </div>
          {fileName && (
            <div>
              <span>Documento</span>
              <strong title={fileName}>{fileName}</strong>
            </div>
          )}
          <div>
            <span>Analizador</span>
            <strong>
              {run.analyzerMode === "ENSEMBLE"
                ? "ENSEMBLE_V2_V3 · V2 + V3"
                : ANALYZER_LABEL[run.analyzerMode]}
            </strong>
          </div>
          <div>
            <span>Perfil</span>
            <strong>
              {PROFILE_LABEL[run.thresholdProfile] ?? run.thresholdProfile}
            </strong>
          </div>
          <div>
            <span>Modo de párrafo</span>
            <strong>
              {run.paragraphMode === "STRICT_PARAGRAPH"
                ? "Solo el párrafo"
                : run.paragraphMode === "CONTEXTUAL_PARAGRAPH"
                  ? "Con contexto breve"
                  : run.paragraphMode ?? "—"}
            </strong>
          </div>
          <div>
            <span>Agregación</span>
            <strong>{run.documentAggregation ?? "—"}</strong>
          </div>
          <div>
            <span>Señal global</span>
            <strong>
              {run.status === "COMPLETED"
                ? formatPercentPoints(runScorePercent)
                : "—"}
            </strong>
          </div>
          <div>
            <span>Nivel</span>
            <strong>
              {signalLevel(run.documentScore)
                ? SIGNAL_LABEL[signalLevel(run.documentScore)!]
                : "—"}
            </strong>
          </div>
          <div>
            <span>Párrafos</span>
            <strong>
              {run.scoredSegments} evaluados · {run.insufficientSegments}{" "}
              insuficientes
            </strong>
          </div>
          <div>
            <span>Duración de inferencia</span>
            <strong>
              {run.inferenceMs !== null
                ? `${(run.inferenceMs / 1000).toFixed(1)} s`
                : "—"}
            </strong>
          </div>
          <div>
            <span>Umbral aplicado</span>
            <strong>{formatPercent(run.threshold)}</strong>
          </div>
          <div>
            <span>Cache hit</span>
            <strong>{cacheHitLabel}</strong>
          </div>
        </div>
      )}
      {run?.status === "FAILED" && (
        <p className="analysis-notice analysis-error" role="alert">
          El análisis seleccionado no se completó ({run.errorCode ?? "error"}).
        </p>
      )}

      {run?.status === "COMPLETED" && researchMode && (
        <div className="analysis-segment-controls">
          <label>
            <span>Filtrar párrafos</span>
            <select
              value={filter}
              onChange={(event) => {
                setFilter(event.currentTarget.value as AnalysisSegmentFilter);
                setPage(1);
              }}
            >
              {ANALYSIS_SEGMENT_FILTERS.map((item) => (
                <option key={item} value={item}>
                  {item === "ALL"
                    ? "Todos los niveles"
                    : item === "INSUFFICIENT"
                      ? "Texto insuficiente"
                      : SIGNAL_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Orden</span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.currentTarget.value as AnalysisSegmentSort);
                setPage(1);
              }}
            >
              <option value="PARAGRAPH">Orden del documento</option>
              <option value="SCORE_DESC">Señal más alta primero</option>
            </select>
          </label>
          <span className="analysis-result-count">
            {totalParagraphs} párrafos
          </span>
        </div>
      )}
      {segmentsError && researchMode && (
        <p className="analysis-notice analysis-error" role="alert">
          {operationErrorMessage("segmentsError")} Run {runId?.slice(0, 8)}.
          La señal global del run sigue disponible.
          <button className="button button-quiet" type="button" onClick={() => void segments.refetch()}>
            Reintentar párrafos
          </button>
        </p>
      )}
      {segments.data && segmentsMatchRun && (
        <>
          {segments.data.stale && (
            <p className="analysis-notice" role="status">
              El texto cambió después de este análisis; los fragmentos no se
              muestran.
            </p>
          )}
          {paragraphItems.length === 0 ? (
            <p className="analysis-notice">No hay párrafos para este filtro.</p>
          ) : (
            <ol className="analysis-paragraphs" aria-label="Señal por párrafo">
              {paragraphItems.map((segment) => {
                const level = signalLevel(segment.calibratedScore);
                const expanded = Boolean(
                  expandedParagraphs[segment.paragraphIndex],
                );
                const preview =
                  segment.text && segment.text.length > 260 && !expanded
                    ? `${segment.text.slice(0, 260)}…`
                    : segment.text;
                return (
                  <li
                    key={segment.paragraphIndex}
                    className={`analysis-paragraph level-${(level ?? "none").toLowerCase()}`}
                  >
                    <div className="analysis-paragraph-head">
                      <strong>Párrafo {segment.paragraphIndex + 1}</strong>
                      <span>
                        {segment.classification === "INSUFFICIENT_TEXT"
                          ? "Texto insuficiente"
                          : `Señal IA ${formatSignal(segment.calibratedScore)}`}
                      </span>
                      {level && (
                        <span className="analysis-level">
                          {SIGNAL_LABEL[level]}
                        </span>
                      )}
                      {segment.pageNumber !== null && (
                        <small>pág. {segment.pageNumber}</small>
                      )}
                      <small>
                        {segment.modelName} · {run?.analyzerMode} ·{" "}
                        {run?.analyzerVersion} · {segment.classification}
                      </small>
                    </div>
                    {preview && <p>{preview}</p>}
                    {segment.text && segment.text.length > 260 && (
                      <button
                        className="analysis-text-toggle"
                        type="button"
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedParagraphs((current) => ({
                            ...current,
                            [segment.paragraphIndex]: !expanded,
                          }))
                        }
                      >
                        {expanded
                          ? "Ocultar texto completo"
                          : "Ver texto completo"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {researchMode && pageCount > 1 && (
            <nav
              className="analysis-pagination"
              aria-label="Paginación de párrafos"
            >
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
              >
                Anterior
              </button>
              <span>
                Página {page} de {pageCount}
              </span>
              <button
                className="button button-quiet"
                type="button"
                onClick={() =>
                  setPage((current) => Math.min(pageCount, current + 1))
                }
                disabled={page >= pageCount}
              >
                Siguiente
              </button>
            </nav>
          )}
        </>
      )}
      {segments.data && !segmentsMatchRun && run?.status === "COMPLETED" && researchMode && (
        <p className="analysis-notice analysis-error" role="alert">
          La respuesta de párrafos no corresponde al análisis seleccionado; no se
          mostrarán fragmentos de otro run.
          <button className="button button-quiet" type="button" onClick={() => void segments.refetch()}>
            Volver a cargar párrafos
          </button>
        </p>
      )}
    </section>
  );
}
