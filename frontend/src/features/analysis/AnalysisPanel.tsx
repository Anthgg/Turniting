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
  getAnalysisSegmentContext,
  type AnalysisSegment,
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
  groupParagraphSegments,
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

function contextTokenLabel(tokens: Record<string, number> | null) {
  if (!tokens || Object.keys(tokens).length === 0) return "Conteo no registrado para este run.";
  return Object.entries(tokens)
    .map(([profile, count]) => `${profile}: ${count} tokens`)
    .join(" · ");
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
  const [expandedInsufficientGroups, setExpandedInsufficientGroups] = useState<
    Record<string, boolean>
  >({});
  const [contextSegmentId, setContextSegmentId] = useState<string | null>(null);

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
      setExpandedInsufficientGroups({});
      setContextSegmentId(null);
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
  const analysisError =
    run?.status === "COMPLETED" ? null : analyze.isError ? analyze.error : null;
  const historyError = runs.isError ? runs.error : null;
  const modelStatusError = models.isError ? models.error : null;
  const segmentsError = segments.isError ? segments.error : null;
  const segmentsMatchRun = segmentsBelongToRun(runId, segments.data);
  const paragraphItems = segmentsMatchRun ? segments.data?.items ?? [] : [];
  const contextSegment = paragraphItems.find(
    (segment) => segment.id === contextSegmentId,
  );
  const segmentContext = useQuery({
    queryKey: analysisQueryKeys.segmentContext(
      runId ?? "none",
      contextSegmentId ?? "none",
    ),
    queryFn: () => getAnalysisSegmentContext(runId as string, contextSegmentId as string),
    enabled: Boolean(
      runId
      && run?.status === "COMPLETED"
      && run.paragraphMode === "CONTEXTUAL_PARAGRAPH"
      && contextSegment?.id,
    ),
    retry: 1,
  });
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

  const runLevel = run ? signalLevel(run.documentScore) : null;

  const enableCompaction = filter === "ALL" && sort === "PARAGRAPH";
  const displayItems = groupParagraphSegments(paragraphItems, enableCompaction);

  const highCount = paragraphItems.filter(
    (s) => s.classification !== "INSUFFICIENT_TEXT" && signalLevel(s.calibratedScore) === "HIGH",
  ).length;
  const moderateCount = paragraphItems.filter(
    (s) => s.classification !== "INSUFFICIENT_TEXT" && signalLevel(s.calibratedScore) === "MODERATE",
  ).length;
  const lowCount = paragraphItems.filter(
    (s) => s.classification !== "INSUFFICIENT_TEXT" && signalLevel(s.calibratedScore) === "LOW",
  ).length;
  const insufficientCount =
    paragraphItems.length > 0
      ? paragraphItems.filter((s) => s.classification === "INSUFFICIENT_TEXT").length
      : (run?.insufficientSegments ?? 0);
  const distTotal = Math.max(1, highCount + moderateCount + lowCount + insufficientCount);

  function jumpToParagraph(paragraphIndex: number) {
    const containingGroup = displayItems.find(
      (item) =>
        item.type === "insufficient-group" &&
        paragraphIndex >= item.startIndex &&
        paragraphIndex <= item.endIndex,
    );
    if (containingGroup && containingGroup.type === "insufficient-group") {
      setExpandedInsufficientGroups((current) => ({
        ...current,
        [containingGroup.groupKey]: true,
      }));
    }
    if (typeof document !== "undefined") {
      window.requestAnimationFrame(() => {
        const element = document.getElementById(`analysis-paragraph-${paragraphIndex}`);
        element?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  function renderParagraphRow(segment: AnalysisSegment) {
    const level = signalLevel(segment.calibratedScore);
    const expanded = Boolean(expandedParagraphs[segment.paragraphIndex]);
    const preview =
      segment.text && segment.text.length > 260 && !expanded
        ? `${segment.text.slice(0, 260)}…`
        : segment.text;
    const canInspectContext =
      run?.paragraphMode === "CONTEXTUAL_PARAGRAPH" &&
      segment.classification !== "INSUFFICIENT_TEXT" &&
      Boolean(segment.id);
    const isContextOpen = Boolean(canInspectContext && contextSegmentId === segment.id);

    return (
      <li
        key={segment.paragraphIndex}
        id={`analysis-paragraph-${segment.paragraphIndex}`}
        className={`analysis-paragraph level-${(level ?? "none").toLowerCase()}`}
      >
        <div className="analysis-paragraph-head">
          <div className="analysis-paragraph-id">
            <strong>Párrafo {segment.paragraphIndex + 1}</strong>
            {segment.pageNumber !== null && <small>pág. {segment.pageNumber}</small>}
          </div>
          <div className="analysis-paragraph-badges">
            <span className="analysis-paragraph-score">
              {segment.classification === "INSUFFICIENT_TEXT"
                ? "Texto insuficiente"
                : formatSignal(segment.calibratedScore)}
            </span>
            {level && (
              <span className={`analysis-level level-pill-${level.toLowerCase()}`}>
                {SIGNAL_LABEL[level]}
              </span>
            )}
            {run?.paragraphMode === "CONTEXTUAL_PARAGRAPH" && (
              <span className="analysis-context-badge">
                {segment.classification === "INSUFFICIENT_TEXT"
                  ? "Contexto no aplicado"
                  : "Contexto utilizado"}
              </span>
            )}
          </div>
        </div>

        {preview && <p className="analysis-paragraph-text">{preview}</p>}

        <div className="analysis-paragraph-footer">
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
              {expanded ? "Ocultar texto completo" : "Ver texto completo"}
            </button>
          )}

          {canInspectContext && (
            <button
              className="analysis-text-toggle"
              type="button"
              aria-expanded={isContextOpen}
              aria-controls={`analysis-context-${segment.id}`}
              onClick={() =>
                setContextSegmentId((current) =>
                  current === segment.id ? null : segment.id ?? null,
                )
              }
            >
              {isContextOpen ? "Ocultar contexto utilizado" : "Ver contexto utilizado"}
            </button>
          )}

          <details className="analysis-paragraph-tech">
            <summary>Detalles técnicos</summary>
            <span>
              {segment.modelName} · {run?.analyzerMode} · {run?.analyzerVersion} ·{" "}
              {segment.classification}
              {segment.words !== undefined ? ` · ${segment.words} palabras` : ""}
            </span>
          </details>
        </div>

        {isContextOpen && (
          <div
            className="analysis-context-drawer"
            id={`analysis-context-${segment.id}`}
            role="region"
            aria-label={`Contexto del párrafo ${segment.paragraphIndex + 1}`}
          >
            {segmentContext.isError && (
              <p className="analysis-context-message" role="alert">
                <span>No se pudo cargar el contexto utilizado.</span>
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => void segmentContext.refetch()}
                >
                  Reintentar
                </button>
              </p>
            )}
            {segmentContext.isPending && !segmentContext.data && (
              <p className="analysis-context-message" role="status">
                Cargando contexto…
              </p>
            )}
            {segmentContext.data && (
              <>
                <p className="analysis-context-explanation">
                  El modelo usa hasta{" "}
                  {segmentContext.data.contextMetadata.tokenLimitPerSide ??
                    "un límite no registrado"}{" "}
                  tokens por lado y ventana. Se muestran los párrafos vecinos
                  completos como referencia; el porcentaje pertenece solo al
                  párrafo evaluado.
                </p>
                <div className="analysis-context-grid">
                  <section className="analysis-context-neighbor">
                    <h4>Anterior</h4>
                    {segmentContext.data.before.paragraphIndex === null ? (
                      <p>No disponible: es el primer párrafo.</p>
                    ) : (
                      <p>{segmentContext.data.before.text}</p>
                    )}
                    {segmentContext.data.before.paragraphIndex !== null && (
                      <small>
                        Tokens usados por ventana ·{" "}
                        {contextTokenLabel(segmentContext.data.before.tokensUsed)}
                      </small>
                    )}
                  </section>
                  <section className="analysis-context-target">
                    <h4>
                      Párrafo evaluado · Señal IA{" "}
                      {formatSignal(segment.calibratedScore)}
                    </h4>
                    <p>{segmentContext.data.target.text}</p>
                  </section>
                  <section className="analysis-context-neighbor">
                    <h4>Siguiente</h4>
                    {segmentContext.data.after.paragraphIndex === null ? (
                      <p>No disponible: es el último párrafo.</p>
                    ) : (
                      <p>{segmentContext.data.after.text}</p>
                    )}
                    {segmentContext.data.after.paragraphIndex !== null && (
                      <small>
                        Tokens usados por ventana ·{" "}
                        {contextTokenLabel(segmentContext.data.after.tokensUsed)}
                      </small>
                    )}
                  </section>
                </div>
              </>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <section
      className={`analysis-panel${researchMode ? " research-analysis-panel" : ""}`}
      aria-labelledby="analysis-title"
    >
      <div className="analysis-header">
        <div className="analysis-header-copy">
          <h2 id="analysis-title">Señal de participación de IA</h2>
          <p className="analysis-disclaimer">
            Estimación experimental independiente. No es un puntaje de Turnitin ni prueba autoría.
          </p>
        </div>
        <Link className="button button-quiet" to="/analysis/compare">
          Comparar versiones
        </Link>
      </div>

      <div className="analysis-toolbar" role="group" aria-label="Configuración del análisis">
        <label className="analysis-toolbar-field">
          <span>Analizador</span>
          <select
            value={analyzer}
            onChange={(event) => {
              analyze.reset();
              setAnalyzer(event.currentTarget.value as AnalyzerName);
            }}
          >
            {ANALYZERS.map((item) => (
              <option key={item} value={item}>
                {item === "ENSEMBLE"
                  ? "ENSEMBLE_V2_V3 · V2 + V3"
                  : ANALYZER_LABEL[item]}
              </option>
            ))}
            {models.data?.items.some((item) => item.name === "EXPERIMENTAL_F006_1_MODEL") && (
              <option value="" disabled>
                EXPERIMENTAL_F006_1_MODEL · No disponible localmente
              </option>
            )}
          </select>
        </label>

        <label className="analysis-toolbar-field">
          <span>Perfil</span>
          <select
            value={profile}
            onChange={(event) => {
              analyze.reset();
              setProfile(event.currentTarget.value as ThresholdProfileName);
            }}
          >
            {THRESHOLD_PROFILES.map((item) => (
              <option key={item} value={item}>
                {PROFILE_LABEL[item]}
              </option>
            ))}
          </select>
        </label>

        <div className="analysis-toolbar-field analysis-paragraph-mode-field">
          <div className="analysis-paragraph-mode-label">
            <label htmlFor="analysis-paragraph-mode">Modo de párrafo</label>
            <details className="analysis-mode-help">
              <summary
                aria-label="Información sobre los modos de párrafo"
                title="Información sobre los modos de párrafo"
              >
                ⓘ
              </summary>
              <div className="analysis-mode-help-content" role="note">
                <strong>Solo el párrafo (Recomendado)</strong>
                <p>
                  Analiza únicamente el párrafo objetivo. Mantiene mayor
                  estabilidad al comparar versiones.
                </p>
                <strong>Con contexto breve (Experimental)</strong>
                <p>
                  Incluye hasta 64 tokens de los párrafos vecinos como
                  referencia; el puntaje pertenece solo al párrafo objetivo.
                </p>
              </div>
            </details>
          </div>
          <select
            id="analysis-paragraph-mode"
            value={mode}
            onChange={(event) => {
              analyze.reset();
              setMode(event.currentTarget.value as ParagraphModeName);
            }}
          >
            {PARAGRAPH_MODES.map((item) => (
              <option key={item} value={item}>
                {item === "STRICT_PARAGRAPH"
                  ? "Solo el párrafo · Recomendado"
                  : "Con contexto breve · Experimental"}
              </option>
            ))}
          </select>
        </div>

        {researchMode && history.length > 0 && (
          <label className="analysis-toolbar-field analysis-history-field">
            <span>Ejecución</span>
            <select
              value={runId ?? ""}
              onChange={(event) => {
                analyze.reset();
                setSelectedRun(event.currentTarget.value);
                setPage(1);
                setExpandedParagraphs({});
                setExpandedInsufficientGroups({});
                setContextSegmentId(null);
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
                    : formatPercentPoints(item.documentScorePercent)}{" "}
                  · {STATUS_LABEL[item.status] ?? item.status}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="analysis-toolbar-action">
          <button
            className="button button-primary"
            type="button"
            disabled={!hasText || analyze.isPending || !usable}
            onClick={() => analyze.mutate()}
            aria-busy={analyze.isPending}
          >
            <Icon name="spark" size={15} />
            <span>{analyze.isPending ? "Analizando…" : "Analizar IA"}</span>
          </button>
        </div>
      </div>

      <div className="analysis-notices-compact">
        {researchMode && (!f006 || !f006.servable) && (
          <p className="analysis-inline-note analysis-inline-warning" role="status">
            <span>
              <strong>F006 no disponible para inferencia:</strong>{" "}
              {f006
                ? availabilityLabel(f006.availability)
                : "No habilitado en el registro local."}
            </span>
          </p>
        )}
        {mode === "CONTEXTUAL_PARAGRAPH" && (
          <p className="analysis-inline-note" role="status">
            Modo contextual seleccionado: añade una ventana breve de párrafos vecinos como referencia; el porcentaje sigue perteneciendo únicamente al párrafo evaluado.
          </p>
        )}
        {modelStatusError && (
          <p className="analysis-notice" role="status">
            {operationErrorMessage("modelStatusError")} El análisis está
            deshabilitado hasta verificar su disponibilidad.
          </p>
        )}
        {!usable && models.data && (
          <p className="analysis-notice" role="status">
            El analizador {modelName} no está disponible ({requiredModels.map((m) => m ? availabilityLabel(m.availability) : "No disponible").join(", ")}).
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
            <span>
              {operationErrorMessage("historyError")} El resultado seleccionado permanece visible.
            </span>
            <button className="button button-quiet" type="button" onClick={() => void runs.refetch()}>
              Reintentar historial
            </button>
          </p>
        )}
        {analysisError && (
          <p className="analysis-notice analysis-error" role="alert">
            <span>
              {analysisError instanceof ApiRequestError
                ? analysisErrorMessage(analysisError.code, analysisError.status)
                : operationErrorMessage("analysisError")}
            </span>
            <button className="button button-quiet" type="button" onClick={() => analyze.mutate()}>
              Reintentar análisis
            </button>
          </p>
        )}
        {analyze.isPending && (
          <p className="analysis-notice" role="status" aria-live="polite">
            Analizando documento localmente ({workflowStatus})…
          </p>
        )}
      </div>

      {run && (
        <div className="analysis-summary-band" aria-label="Resultado del análisis">
          <div className="analysis-hero-metric">
            <span className="analysis-hero-label">Señal global</span>
            <strong className="analysis-hero-score">
              {run.status === "COMPLETED"
                ? formatPercentPoints(runScorePercent)
                : "—"}
            </strong>
            <div className="analysis-hero-badges">
              <span className={`analysis-level level-pill-${(runLevel ?? "none").toLowerCase()}`}>
                {runLevel ? SIGNAL_LABEL[runLevel] : "Sin nivel"}
              </span>
              <span className="analysis-hero-sub">
                {STATUS_LABEL[run.status] ?? run.status}
              </span>
            </div>

            {run.status === "COMPLETED" && (
              <div className="analysis-distribution" aria-label="Distribución de señal en la vista actual">
                <div className="analysis-distribution-bar" role="presentation">
                  {highCount > 0 && (
                    <span
                      className="dist-segment dist-high"
                      style={{ width: `${(highCount / distTotal) * 100}%` }}
                      title={`Alta: ${highCount}`}
                    />
                  )}
                  {moderateCount > 0 && (
                    <span
                      className="dist-segment dist-moderate"
                      style={{ width: `${(moderateCount / distTotal) * 100}%` }}
                      title={`Moderada: ${moderateCount}`}
                    />
                  )}
                  {lowCount > 0 && (
                    <span
                      className="dist-segment dist-low"
                      style={{ width: `${(lowCount / distTotal) * 100}%` }}
                      title={`Baja: ${lowCount}`}
                    />
                  )}
                  {insufficientCount > 0 && (
                    <span
                      className="dist-segment dist-insufficient"
                      style={{ width: `${(insufficientCount / distTotal) * 100}%` }}
                      title={`Insuficiente: ${insufficientCount}`}
                    />
                  )}
                </div>
                <div className="analysis-distribution-legend">
                  <span><i className="dist-dot dist-high" />Alta ({highCount})</span>
                  <span><i className="dist-dot dist-moderate" />Moderada ({moderateCount})</span>
                  <span><i className="dist-dot dist-low" />Baja ({lowCount})</span>
                  <span><i className="dist-dot dist-insufficient" />Insuf. ({insufficientCount})</span>
                </div>
              </div>
            )}
          </div>

          <dl className="analysis-meta-grid">
            <div>
              <dt>Estado</dt>
              <dd>{STATUS_LABEL[run.status] ?? run.status} · {workflowStatus}</dd>
            </div>
            <div>
              <dt>Run ID</dt>
              <dd className="analysis-mono" title={run.id}>{run.id.slice(0, 8)}</dd>
            </div>
            <div>
              <dt>Fecha</dt>
              <dd>{runDate(run.createdAt)}</dd>
            </div>
            <div>
              <dt>Analizador</dt>
              <dd>
                {run.analyzerMode === "ENSEMBLE"
                  ? "ENSEMBLE_V2_V3 · V2 + V3"
                  : ANALYZER_LABEL[run.analyzerMode]}
              </dd>
            </div>
            <div>
              <dt>Perfil</dt>
              <dd>{PROFILE_LABEL[run.thresholdProfile] ?? run.thresholdProfile}</dd>
            </div>
            <div>
              <dt>Modo de párrafo</dt>
              <dd>
                {run.paragraphMode === "STRICT_PARAGRAPH"
                  ? "Solo el párrafo"
                  : run.paragraphMode === "CONTEXTUAL_PARAGRAPH"
                    ? "Con contexto breve"
                    : run.paragraphMode ?? "—"}
              </dd>
            </div>
            <div>
              <dt>Umbral</dt>
              <dd>{formatPercent(run.threshold)}</dd>
            </div>
            <div>
              <dt>Duración</dt>
              <dd>
                {run.inferenceMs !== null
                  ? `${(run.inferenceMs / 1000).toFixed(1)} s`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Cache hit</dt>
              <dd>{cacheHitLabel}</dd>
            </div>
            <div>
              <dt>Párrafos</dt>
              <dd>
                {run.scoredSegments} evaluados · {run.insufficientSegments} insuficientes
              </dd>
            </div>
            <div>
              <dt>Agregación</dt>
              <dd className="analysis-mono">{run.documentAggregation ?? "—"}</dd>
            </div>
            {fileName && (
              <div>
                <dt>Documento</dt>
                <dd title={fileName}>{fileName}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {run?.status === "FAILED" && (
        <p className="analysis-notice analysis-error" role="alert">
          El análisis seleccionado no se completó ({run.errorCode ?? "error"}).
        </p>
      )}

      {run?.status === "COMPLETED" && researchMode && (
        <div className="analysis-list-bar">
          <div className="analysis-list-heading">
            <h3>Párrafos del documento</h3>
            <span className="analysis-result-count">
              {totalParagraphs} {totalParagraphs === 1 ? "párrafo" : "párrafos"}
            </span>
          </div>
          <div className="analysis-segment-controls">
            <label>
              <span>Filtrar</span>
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
              <span>Ordenar</span>
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
          </div>
        </div>
      )}

      {segmentsError && researchMode && (
        <p className="analysis-notice analysis-error" role="alert">
          <span>
            {operationErrorMessage("segmentsError")} Run {runId?.slice(0, 8)}.
            La señal global del run sigue disponible.
          </span>
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
            <>
              <div
                className="analysis-heatmap-strip"
                role="navigation"
                aria-label="Mapa de navegación de párrafos"
              >
                <span className="analysis-heatmap-caption">Mapa de párrafos</span>
                <div className="analysis-heatmap-track">
                  {paragraphItems.map((segment) => {
                    const level = signalLevel(segment.calibratedScore);
                    const cellTone =
                      segment.classification === "INSUFFICIENT_TEXT"
                        ? "insufficient"
                        : (level ?? "low").toLowerCase();
                    const cellLabel =
                      segment.classification === "INSUFFICIENT_TEXT"
                        ? `Párrafo ${segment.paragraphIndex + 1}: Texto insuficiente`
                        : `Párrafo ${segment.paragraphIndex + 1}: ${formatSignal(segment.calibratedScore)} (${level ? SIGNAL_LABEL[level] : ""})`;
                    return (
                      <button
                        key={segment.paragraphIndex}
                        type="button"
                        className={`heatmap-cell heatmap-cell-${cellTone}`}
                        title={cellLabel}
                        aria-label={cellLabel}
                        onClick={() => jumpToParagraph(segment.paragraphIndex)}
                      />
                    );
                  })}
                </div>
              </div>

              <ol className="analysis-paragraphs" aria-label="Señal por párrafo">
                {displayItems.map((item) => {
                  if (item.type === "single") {
                    return renderParagraphRow(item.segment);
                  }

                  const isGroupExpanded = Boolean(
                    expandedInsufficientGroups[item.groupKey],
                  );
                  const count = item.items.length;

                  if (!isGroupExpanded) {
                    return (
                      <li
                        key={`group-${item.groupKey}`}
                        className="analysis-paragraph analysis-insufficient-group"
                      >
                        <div className="analysis-insufficient-group-bar">
                          <div className="analysis-insufficient-group-copy">
                            <strong>
                              Párrafos {item.startIndex + 1}–{item.endIndex + 1}
                            </strong>
                            <span>
                              {count} bloques cortos / títulos con texto insuficiente
                            </span>
                          </div>
                          <button
                            type="button"
                            className="analysis-text-toggle"
                            aria-expanded={false}
                            onClick={() =>
                              setExpandedInsufficientGroups((current) => ({
                                ...current,
                                [item.groupKey]: true,
                              }))
                            }
                          >
                            Expandir ({count})
                          </button>
                        </div>
                      </li>
                    );
                  }

                  return (
                    <li
                      key={`group-${item.groupKey}`}
                      className="analysis-insufficient-expanded-wrap"
                    >
                      <div className="analysis-insufficient-group-bar is-expanded">
                        <div className="analysis-insufficient-group-copy">
                          <strong>
                            Párrafos {item.startIndex + 1}–{item.endIndex + 1}
                          </strong>
                          <span>Mostrando {count} bloques con texto insuficiente</span>
                        </div>
                        <button
                          type="button"
                          className="analysis-text-toggle"
                          aria-expanded={true}
                          onClick={() =>
                            setExpandedInsufficientGroups((current) => ({
                              ...current,
                              [item.groupKey]: false,
                            }))
                          }
                        >
                          Compactar ({count})
                        </button>
                      </div>
                      <ol className="analysis-insufficient-sublist">
                        {item.items.map((segment) => renderParagraphRow(segment))}
                      </ol>
                    </li>
                  );
                })}
              </ol>
            </>
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
          <span>
            La respuesta de párrafos no corresponde al análisis seleccionado; no se
            mostrarán fragmentos de otro run.
          </span>
          <button className="button button-quiet" type="button" onClick={() => void segments.refetch()}>
            Volver a cargar párrafos
          </button>
        </p>
      )}
    </section>
  );
}

