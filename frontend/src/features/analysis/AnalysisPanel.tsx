import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ANALYZERS,
  ANALYSIS_SEGMENT_FILTERS,
  PARAGRAPH_MODES,
  THRESHOLD_PROFILES,
  analysisQueryKeys,
  analyzeDocument,
  getAnalysisReviewDocument,
  getAnalysisSegments,
  listAnalyzerModels,
  listDocumentAnalyses,
  getAnalysisSegmentContext,
  getAnalysisTechnicalPresentation,
  type AnalysisSegment,
  type AnalysisSegmentFilter,
  type AnalysisSegmentSort,
  type AnalyzerName,
  type LanguageCode,
  type ParagraphModeName,
  type ThresholdProfileName,
} from "../../api/analysis";
import { ApiRequestError } from "../../api/client";
import { CustomSelect } from "../../components/CustomSelect";
import { Icon } from "../../components/Icon";
import { TurnitingFeedback } from "../../components/TurnitingFeedback";
import { splitReviewText } from "./review-text";
import { TechnicalGroupedDetail } from "./TechnicalGroupedDetail";
import { technicalPercentage } from "./technical-presentation-utils";
import { actionableReviewSegments, nextReviewNavigationIndex, reviewEvidenceForSegment, reviewThresholdLabel } from "./review-presentation";
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
  F006_1_ONLY: "EXPERIMENTAL_F006_1_MODEL",
  F006_1_1_ONLY: "EXPERIMENTAL_F006_1_1_MODEL",
};

const ANALYZER_FOR_MODEL: Record<string, AnalyzerName> = {
  CANDIDATE_MODEL_V2: "V2_ONLY",
  CANDIDATE_MODEL_V3: "V3_ONLY",
  ENSEMBLE_V2_V3: "ENSEMBLE",
  EXPERIMENTAL_F006_1_MODEL: "F006_1_ONLY",
  EXPERIMENTAL_F006_1_1_MODEL: "F006_1_1_ONLY",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendiente",
  RUNNING: "Analizando",
  COMPLETED: "Completado",
  FAILED: "Error",
};

type AnalysisView = "SUMMARY" | "REVIEW" | "DETAIL";

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
  initialView = "SUMMARY",
  initialDetailMode = "GROUPED",
}: {
  documentId: string;
  fileName?: string;
  hasText: boolean;
  researchMode?: boolean;
  documentWorkflowStatus?: string;
  initialView?: AnalysisView;
  initialDetailMode?: "GROUPED" | "SEGMENTS";
}) {
  const queryClient = useQueryClient();
  const models = useQuery({
    queryKey: analysisQueryKeys.models(),
    queryFn: listAnalyzerModels,
    retry: 1,
  });
  const analyzerTouched = useRef(false);
  const preferredAnalyzer = models.data?.resolvedLocalPreferredAnalyzer;
  const preferredMode = preferredAnalyzer
    ? ANALYZER_FOR_MODEL[preferredAnalyzer]
    : undefined;
  const [analyzer, setAnalyzer] = useState<AnalyzerName>(
    () => preferredMode ?? (researchMode ? "ENSEMBLE" : "V3_ONLY"),
  );
  const [profile, setProfile] = useState<ThresholdProfileName>(
    researchMode ? "BALANCED" : "LOW_FALSE_POSITIVE",
  );
  const [mode, setMode] = useState<ParagraphModeName>(DEFAULT_PARAGRAPH_MODE);
  const [languageCode, setLanguageCode] = useState<LanguageCode>("es");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [collapsedSettingsRunId, setCollapsedSettingsRunId] = useState<string | null>(null);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
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
  const [activeView, setActiveView] = useState<AnalysisView>(initialView);
  const [reviewSelectedParagraphIndex, setReviewSelectedParagraphIndex] = useState<number | null>(null);
  const [reviewContextOpen, setReviewContextOpen] = useState(false);
  const [reviewNavigationIndex, setReviewNavigationIndex] = useState(0);
  const [reviewJump, setReviewJump] = useState<{ paragraphIndex: number | null; sequence: number }>({
    paragraphIndex: null,
    sequence: 0,
  });
  const [detailMode, setDetailMode] = useState<"GROUPED" | "SEGMENTS">(initialDetailMode);

  useEffect(() => {
    if (!models.data || analyzerTouched.current) return;
    const preferred = models.data.resolvedLocalPreferredAnalyzer;
    const preferredMode = preferred ? ANALYZER_FOR_MODEL[preferred] : undefined;
    if (!preferredMode) return;
    setAnalyzer(preferredMode);
    if (preferredMode === "F006_1_ONLY" || preferredMode === "F006_1_1_ONLY") {
      setProfile("BALANCED");
    }
  }, [models.data, researchMode]);
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
  const reviewDocument = useQuery({
    queryKey: analysisQueryKeys.reviewDocument(runId ?? "none"),
    queryFn: () => getAnalysisReviewDocument(runId as string),
    enabled: Boolean(runId && run?.status === "COMPLETED" && activeView === "REVIEW"),
    retry: 1,
  });

  const analyze = useMutation({
    mutationFn: () =>
      analyzeDocument(documentId, {
        analyzer,
        thresholdProfile: profile,
        paragraphMode: mode,
        ...(analyzer === "F006_1_ONLY" || analyzer === "F006_1_1_ONLY"
          ? { languageCode }
          : {}),
      }),
    onSuccess: async (result) => {
      setSelectedRun(result.id);
      setCollapsedSettingsRunId(result.id);
      setSettingsExpanded(false);
      setPage(1);
      setFilter("ALL");
      setExpandedParagraphs({});
      setExpandedInsufficientGroups({});
      setContextSegmentId(null);
      setActiveView("SUMMARY");
      setReviewSelectedParagraphIndex(null);
      setReviewContextOpen(false);
      setReviewNavigationIndex(0);
      setReviewJump({ paragraphIndex: null, sequence: 0 });
      setDetailMode("GROUPED");
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
  const f0061 = models.data?.items.find(
    (item) => item.name === "EXPERIMENTAL_F006_1_MODEL",
  );
  const f00611 = models.data?.items.find(
    (item) => item.name === "EXPERIMENTAL_F006_1_1_MODEL",
  );
  const f0061Usable = Boolean(f0061?.servable && isAnalyzerUsable(f0061.availability));
  const f00611Usable = Boolean(f00611?.servable && isAnalyzerUsable(f00611.availability));
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
  const technicalPresentation = useQuery({
    queryKey: analysisQueryKeys.technicalPresentation(runId ?? "none"),
    queryFn: () => getAnalysisTechnicalPresentation(runId as string),
    enabled: Boolean(runId && run?.status === "COMPLETED"),
    retry: 1,
  });
  const presentationData = technicalPresentation.data?.analysisRunId === runId
    ? technicalPresentation.data
    : undefined;
  const presentationCounts = presentationData?.counts;
  const visualThresholdLabel = reviewThresholdLabel(reviewDocument.data ?? presentationData);
  const reviewHighlightCount = presentationData?.reviewHighlightedCount ?? presentationCounts?.reviewHighlightedCount ?? presentationCounts?.actionableHighlightCount;
  const totalParagraphs = segmentsMatchRun
    ? (segments.data?.total ?? paragraphItems.length)
    : 0;
  const pageCount = segmentsMatchRun ? (segments.data?.pages ?? 1) : 1;
  const runMetadata = run && isRecord(run.metadata) ? run.metadata : {};
  const settingsCollapsed = run?.status === "COMPLETED"
    && run.id === collapsedSettingsRunId
    && !settingsExpanded;
  const appliedLanguageCode = typeof runMetadata.languageCode === "string"
    ? runMetadata.languageCode
    : null;
  const appliedLanguageLabel = appliedLanguageCode === "es"
    ? "Español · calibración española"
    : appliedLanguageCode === "en"
      ? "Inglés · calibración global"
      : appliedLanguageCode === "other"
        ? "Otro o desconocido · calibración global"
        : "No registrado";
  const analyzerUsesLanguage = run?.analyzerMode === "F006_1_ONLY"
    || run?.analyzerMode === "F006_1_1_ONLY";
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

  useEffect(() => {
    if (
      activeView !== "REVIEW" ||
      reviewJump.paragraphIndex === null ||
      !reviewDocument.data
    ) return;
    window.requestAnimationFrame(() => {
      document
        .getElementById(`analysis-review-paragraph-${reviewJump.paragraphIndex}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [activeView, reviewJump.paragraphIndex, reviewJump.sequence, reviewDocument.data]);

  useEffect(() => {
    if (!reviewContextOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setReviewContextOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [reviewContextOpen]);

  const displayItems = groupParagraphSegments(paragraphItems, false);
  const reviewSegments = [...(reviewDocument.data?.items ?? [])].sort(
    (left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd,
  );
  const reviewFlaggedSegments = actionableReviewSegments(
    reviewSegments,
    presentationData?.actionableParagraphIndices,
  );
  const selectedFlaggedIndex = reviewFlaggedSegments.findIndex(
    (segment) => segment.paragraphIndex === reviewSelectedParagraphIndex,
  );
  const visibleFlaggedIndex = selectedFlaggedIndex >= 0
    ? selectedFlaggedIndex
    : Math.min(reviewNavigationIndex, Math.max(0, reviewFlaggedSegments.length - 1));
  const selectedReviewSegment = reviewSegments.find(
    (segment) => segment.paragraphIndex === reviewSelectedParagraphIndex,
  );
  const selectedReviewEvidence = selectedReviewSegment
    ? reviewEvidenceForSegment(selectedReviewSegment, run?.threshold ?? null)
    : null;
  const reviewText = reviewDocument.data?.documentText ?? "";
  const reviewBlocks: ReactNode[] = [];
  if (reviewDocument.data && !reviewDocument.data.stale) {
    let reviewCursor = 0;
    for (const segment of reviewSegments) {
      if (segment.charStart > reviewCursor) {
        const gap = reviewText.slice(reviewCursor, segment.charStart);
        reviewBlocks.push(
          <div
            className="analysis-review-gap"
            key={`review-gap-${segment.paragraphIndex}`}
            aria-hidden={!gap.trim()}
          >
            {gap}
          </div>,
        );
      }
      const exactText = reviewText.slice(segment.charStart, segment.charEnd);
      const presentation = segment.reviewPresentation;
      const evidence = reviewEvidenceForSegment(segment, run?.threshold ?? null);
      const selected = reviewSelectedParagraphIndex === segment.paragraphIndex;
      const actionable = evidence.reviewHighlighted;
      const textParts = splitReviewText(exactText, evidence, segment.charStart);
      const renderedText = textParts.map((part, index) => part.highlighted
        ? <mark className="analysis-review-highlight" key={`highlight-${index}`}>{part.text}</mark>
        : <span key={`text-${index}`}>{part.text}</span>);
      reviewBlocks.push(
        <article
          className={`analysis-review-paragraph${actionable ? " is-actionable" : ""}`}
          id={`analysis-review-paragraph-${segment.paragraphIndex}`}
          key={`review-paragraph-${segment.paragraphIndex}`}
        >
          {actionable ? (
            <button
              className="analysis-review-paragraph-action"
              type="button"
              aria-pressed={selected}
              aria-label={`Párrafo ${segment.paragraphIndex + 1}, ${formatSignal(segment.calibratedScore)}, resaltado para revisión, umbral visual ${visualThresholdLabel}`}
              onClick={() => {
                setReviewSelectedParagraphIndex(selected ? null : segment.paragraphIndex);
                setReviewContextOpen(!selected);
                const index = reviewFlaggedSegments.findIndex((item) => item.paragraphIndex === segment.paragraphIndex);
                if (index >= 0) setReviewNavigationIndex(index);
              }}
            >
              <span className="analysis-review-paragraph-text">{renderedText}</span>
            </button>
          ) : (
            <p className="analysis-review-paragraph-text">{renderedText}</p>
          )}
          {presentation?.excludedReason === "REFERENCE_SECTION" && (
            <small className="analysis-review-reference-label">Referencia bibliográfica</small>
          )}
        </article>,
      );
      reviewCursor = Math.max(reviewCursor, segment.charEnd);
    }
    if (reviewCursor < reviewText.length) {
      reviewBlocks.push(
        <div className="analysis-review-gap" key="review-tail" aria-hidden={!reviewText.slice(reviewCursor).trim()}>
          {reviewText.slice(reviewCursor)}
        </div>,
      );
    }
  }

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
    setActiveView("REVIEW");
    setReviewJump((current) => ({
      paragraphIndex,
      sequence: current.sequence + 1,
    }));
  }

  function navigateFlagged(direction: -1 | 1) {
    const nextIndex = nextReviewNavigationIndex(reviewFlaggedSegments.length, selectedFlaggedIndex, reviewNavigationIndex, direction);
    if (nextIndex === null) return;
    const segment = reviewFlaggedSegments[nextIndex]!;
    setReviewNavigationIndex(nextIndex);
    setActiveView("REVIEW");
    setReviewSelectedParagraphIndex(segment.paragraphIndex);
    setReviewContextOpen(true);
    setReviewJump((current) => ({ paragraphIndex: segment.paragraphIndex, sequence: current.sequence + 1 }));
  }

  function renderParagraphRow(segment: AnalysisSegment) {
    const level = signalLevel(segment.calibratedScore);
    const evidence = reviewEvidenceForSegment(segment, run?.threshold ?? null);
    const unitLabel = segment.kind === "PARAGRAPH" ? "Párrafo" : "Segmento";
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
            <strong>{unitLabel} {segment.paragraphIndex + 1}</strong>
            {segment.pageNumber !== null && <small>pág. {segment.pageNumber}</small>}
          </div>
          <div className="analysis-paragraph-badges">
            <span className="analysis-paragraph-score">
              {evidence.evaluated ? technicalPercentage(segment.calibratedScore) : "NO EVALUADO"}
            </span>
            <span className="analysis-threshold-state">Detector: {!evidence.evaluated ? "NO EVALUADO" : evidence.flagged ? "SEÑALADO" : "NO SEÑALADO"}</span>
            <span className="analysis-review-state">Revisión: {evidence.reviewHighlighted ? "RESALTADO" : "NO RESALTADO"}</span>
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
        {evidence.presentationExcluded && <p className="analysis-presentation-excluded">EXCLUIDO DE REVISIÓN VISUAL · {evidence.excludedReason}</p>}

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

          <button
            className="analysis-text-toggle"
            type="button"
            onClick={() => jumpToParagraph(segment.paragraphIndex)}
          >
            Ver en Revisión
          </button>

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

      <div className={`analysis-toolbar${settingsCollapsed ? " is-collapsed" : ""}`} role="group" aria-label="Configuración del análisis">
        {settingsCollapsed && run && (
          <dl className="analysis-applied-settings" aria-label="Parámetros aplicados">
            <div><dt>Analizador</dt><dd>{ANALYZER_LABEL[run.analyzerMode] ?? run.analyzerMode}</dd></div>
            <div><dt>Perfil</dt><dd>{PROFILE_LABEL[run.thresholdProfile] ?? run.thresholdProfile}</dd></div>
            <div><dt>Modo</dt><dd>{run.paragraphMode === "STRICT_PARAGRAPH" ? "Solo el párrafo" : run.paragraphMode === "CONTEXTUAL_PARAGRAPH" ? "Con contexto breve" : run.paragraphMode ?? "No disponible"}</dd></div>
            <div><dt>Idioma</dt><dd>{analyzerUsesLanguage ? appliedLanguageLabel : "No aplica"}</dd></div>
          </dl>
        )}
        {!settingsCollapsed && <>
        <div className="analysis-toolbar-field">
          <span>Analizador</span>
          <CustomSelect
            id="analysis-analyzer"
            label="Analizador"
            value={analyzer}
            options={[
              ...ANALYZERS.filter((item) => item !== "F006_1_ONLY" && item !== "F006_1_1_ONLY").map((item) => ({
                value: item,
                label: item === "ENSEMBLE"
                  ? "ENSEMBLE_V2_V3 · V2 + V3"
                  : ANALYZER_LABEL[item],
              })),
              ...((researchMode || models.data?.localPreferredAnalyzer === "EXPERIMENTAL_F006_1_MODEL") && f0061Usable
                ? [{ value: "F006_1_ONLY", label: "F006.1 · Experimental" }]
                : []),
              ...((researchMode || models.data?.localPreferredAnalyzer === "EXPERIMENTAL_F006_1_MODEL") && f0061 && !f0061Usable
                ? [{ value: "F006_1_ONLY", label: "F006.1 · Experimental · No disponible localmente", disabled: true }]
                : []),
              ...(researchMode && f00611Usable
                ? [{ value: "F006_1_1_ONLY", label: "F006.1.1 · Experimental" }]
                : []),
              ...(researchMode && f00611 && !f00611Usable
                ? [{ value: "F006_1_1_ONLY", label: "F006.1.1 · Experimental · No disponible localmente", disabled: true }]
                : []),
            ]}
            onChange={(value) => {
              analyze.reset();
              analyzerTouched.current = true;
              const next = value as AnalyzerName;
              setAnalyzer(next);
              if (next === "F006_1_ONLY" || next === "F006_1_1_ONLY") {
                setProfile("BALANCED");
              }
            }}
          />
        </div>

        {(analyzer === "F006_1_ONLY" || analyzer === "F006_1_1_ONLY") && (
          <div className="analysis-toolbar-field">
            <span>Idioma para calibración</span>
            <CustomSelect
              id="analysis-language-code"
              label="Idioma para calibración"
              value={languageCode}
              options={[
                { value: "es", label: "Español · calibración española" },
                { value: "en", label: "Inglés · calibración global" },
                { value: "other", label: "Otro o desconocido · calibración global" },
              ]}
              onChange={(value) => {
                analyze.reset();
                setLanguageCode(value as LanguageCode);
              }}
            />
          </div>
        )}

        {models.data?.localPreferredWarning && (
          <p className="analysis-disclaimer analysis-preferred-warning" role="status">
            {models.data.localPreferredWarning}
          </p>
        )}

        <div className="analysis-toolbar-field">
          <span>Perfil</span>
          <CustomSelect
            id="analysis-threshold-profile"
            label="Perfil"
            value={profile}
            options={THRESHOLD_PROFILES.map((item) => ({ value: item, label: PROFILE_LABEL[item] }))}
            onChange={(value) => {
              analyze.reset();
              setProfile(value as ThresholdProfileName);
            }}
          />
        </div>

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
          <CustomSelect
            id="analysis-paragraph-mode"
            label="Modo de párrafo"
            value={mode}
            options={PARAGRAPH_MODES.map((item) => ({
              value: item,
              label: item === "STRICT_PARAGRAPH"
                ? "Solo el párrafo · Recomendado"
                : "Con contexto breve · Experimental",
            }))}
            onChange={(value) => {
              analyze.reset();
              setMode(value as ParagraphModeName);
            }}
          />
        </div>

        {researchMode && history.length > 0 && (
          <div className="analysis-toolbar-field analysis-history-field">
            <span>Ejecución</span>
            <CustomSelect
              id="analysis-history-run"
              label="Ejecución"
              value={runId ?? ""}
              options={history.map((item) => ({
                value: item.id,
                label: `${runDate(item.createdAt)} · ${ANALYZER_LABEL[item.analyzerMode]} · ${PROFILE_LABEL[item.thresholdProfile] ?? item.thresholdProfile} · ${item.documentScorePercent === undefined ? formatSignal(item.documentScore) : formatPercentPoints(item.documentScorePercent)} · ${STATUS_LABEL[item.status] ?? item.status}`,
              }))}
              onChange={(value) => {
                analyze.reset();
                setSelectedRun(value);
              setSettingsExpanded(false);
                setPage(1);
                setExpandedParagraphs({});
                setExpandedInsufficientGroups({});
                setContextSegmentId(null);
                setActiveView("SUMMARY");
                setReviewSelectedParagraphIndex(null);
                setReviewNavigationIndex(0);
                setReviewJump({ paragraphIndex: null, sequence: 0 });
              }}
            />
          </div>
        )}
        </>}

        <div className="analysis-toolbar-action">
          <button
            className={`button ${settingsCollapsed ? "button-quiet" : "button-primary"}`}
            type="button"
            disabled={!settingsCollapsed && (!hasText || analyze.isPending || !usable)}
            onClick={() => settingsCollapsed ? setSettingsExpanded(true) : analyze.mutate()}
            aria-busy={analyze.isPending}
          >
            {!settingsCollapsed && <Icon name="spark" size={15} />}
            <span>{settingsCollapsed ? "Cambiar parámetros" : analyze.isPending ? "Analizando…" : run?.status === "COMPLETED" ? "Reanalizar" : "Analizar IA"}</span>
          </button>
        </div>
      </div>

      <div className="analysis-notices-compact">
        {researchMode && (!f006 || !f006.servable) && (
          <p className="analysis-inline-note analysis-inline-warning" role="status">
            <span>
              <strong>F006 base no disponible para inferencia:</strong>{" "}
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
          <TurnitingFeedback state="analyzing" title="Analizando el documento" description={`Evaluación local en curso (${workflowStatus}). El estado se mantiene indeterminado hasta recibir el resultado.`} className="analysis-notice" layout="inline" />
        )}
      </div>

      {run?.status === "COMPLETED" && (
        <div className="analysis-view-tabs" role="tablist" aria-label="Vistas del análisis">
          <button
            id="analysis-tab-summary"
            className={activeView === "SUMMARY" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeView === "SUMMARY"}
            aria-controls="analysis-summary-view"
            onClick={() => setActiveView("SUMMARY")}
          >
            Resumen
          </button>
          <button
            id="analysis-tab-review"
            className={activeView === "REVIEW" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeView === "REVIEW"}
            aria-controls="analysis-review-view"
            onClick={() => {
              setActiveView("REVIEW");
              setReviewSelectedParagraphIndex(null);
              setReviewContextOpen(false);
            }}
          >
            Revisión
          </button>
          <button
            id="analysis-tab-detail"
            className={activeView === "DETAIL" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={activeView === "DETAIL"}
            aria-controls="analysis-detail-view"
            onClick={() => setActiveView("DETAIL")}
          >
            Detalle
          </button>
        </div>
      )}

      {run && (run.status !== "COMPLETED" || activeView === "SUMMARY") && (
        <div
          className="analysis-summary-band"
          id="analysis-summary-view"
          role={run.status === "COMPLETED" ? "tabpanel" : undefined}
          aria-labelledby={run.status === "COMPLETED" ? "analysis-tab-summary" : undefined}
        >
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
              <dt>Umbral del detector</dt>
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
              <dt>Estado del detector</dt>
              <dd>
                {presentationCounts?.evaluatedSegments ?? run.evaluatedSegments ?? run.scoredSegments} evaluados · {presentationCounts?.rawFlaggedCount ?? run.flaggedSegments ?? "—"} señalados por detector · {run.insufficientSegments} insuficientes
              </dd>
            </div>
            {run.status === "COMPLETED" && <div>
              <dt>Resaltados para revisión</dt>
              <dd>{reviewHighlightCount ?? "—"} resaltados · {presentationCounts?.presentationExcludedFlagged ?? "—"} señalados por detector excluidos de revisión visual</dd>
            </div>}
            {run.status === "COMPLETED" && <div><dt>Umbral de revisión visual</dt><dd>{visualThresholdLabel}</dd></div>}
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

      {run?.status === "COMPLETED" && activeView === "REVIEW" && (
        <section
          className="analysis-review-view"
          id="analysis-review-view"
          role="tabpanel"
          aria-labelledby="analysis-tab-review"
          aria-label="Documento para revisión"
        >
          <header className="analysis-review-heading">
            <div>
              <h3>Documento para revisión</h3>
              <p>El texto conserva el orden del documento y muestra la unidad revisada por el análisis.</p>
              <p className="analysis-review-counts" aria-label="Conteos de revisión">
                {reviewHighlightCount ?? reviewFlaggedSegments.length} fragmentos resaltados para revisión visual
              </p>
            </div>
            <nav className="analysis-review-navigation" aria-label="Navegación por resaltados para revisión">
              <button className="button button-quiet" type="button" disabled={!reviewFlaggedSegments.length} onClick={() => navigateFlagged(-1)}>
                Anterior
              </button>
              <span aria-live="polite">
                {reviewFlaggedSegments.length
                  ? `Resaltado ${visibleFlaggedIndex + 1} de ${reviewFlaggedSegments.length}`
                  : "Sin resaltados para revisión"}
              </span>
              <button className="button button-quiet" type="button" disabled={!reviewFlaggedSegments.length} onClick={() => navigateFlagged(1)}>
                Siguiente
              </button>
            </nav>
            {fileName && <span className="analysis-review-filename">{fileName}</span>}
          </header>
          {reviewDocument.isPending && !reviewDocument.data && (
            <p className="analysis-notice" role="status">Cargando documento para revisión…</p>
          )}
          {reviewDocument.isError && (
            <p className="analysis-notice analysis-error" role="alert">
              {reviewDocument.error instanceof ApiRequestError && reviewDocument.error.code
                ? `No se pudo validar la vista de revisión (${reviewDocument.error.code}). El texto y los rangos del análisis deben coincidir.`
                : "No se pudo cargar el documento para revisión."}
              <button className="button button-quiet" type="button" onClick={() => void reviewDocument.refetch()}>
                Reintentar
              </button>
            </p>
          )}
          {reviewDocument.data?.stale && (
            <p className="analysis-notice analysis-error" role="alert">
              El texto de esta versión no coincide con los rangos guardados. No se mostrarán resaltados.
            </p>
          )}
          {reviewDocument.data && !reviewDocument.data.stale && (
            <>
              <div className="analysis-review-legend" aria-label="Leyenda de resaltados">
                <span><i className="review-legend-high" /> Señal local {visualThresholdLabel}: resaltado para revisión</span>
                <span>El criterio visual es independiente del umbral de clasificación del modelo.</span>
              </div>
              <div className="analysis-review-workspace">
                <div className="analysis-review-document" aria-label="Texto completo en orden documental">
                  {reviewBlocks}
                </div>
                <aside className={`analysis-review-context${reviewContextOpen ? " is-open" : ""}`} aria-label="Panel contextual de revisión">
                  <div className="analysis-review-context-heading">
                    <div>
                      <span>Señal global</span>
                      <strong>{formatPercentPoints(runScorePercent)}</strong>
                      <small>{reviewHighlightCount ?? reviewFlaggedSegments.length} fragmentos resaltados para revisar</small>
                    </div>
                    <button
                      className="analysis-review-context-toggle"
                      type="button"
                      aria-expanded={reviewContextOpen}
                      aria-controls="analysis-review-context-body"
                      onClick={() => setReviewContextOpen((open) => !open)}
                    >
                      {reviewContextOpen ? "Ocultar contexto" : "Mostrar contexto"}
                    </button>
                  </div>
                  <div className="analysis-review-context-body" id="analysis-review-context-body">
                    {selectedReviewSegment && selectedReviewEvidence ? (
                      <>
                        <div className="analysis-review-context-segment-head">
                          <h4>Párrafo {selectedReviewSegment.paragraphIndex + 1}</h4>
                          <button
                            className="analysis-text-toggle"
                            type="button"
                            onClick={() => {
                              setReviewSelectedParagraphIndex(null);
                              setReviewContextOpen(false);
                            }}
                          >
                            Quitar selección
                          </button>
                        </div>
                        <dl className="analysis-review-context-summary">
                          <div>
                            <dt>Señal local</dt>
                            <dd>{technicalPercentage(selectedReviewSegment.calibratedScore)}</dd>
                          </div>
                          <div>
                            <dt>Detector</dt>
                            <dd>{!selectedReviewEvidence.evaluated ? "NO EVALUADO" : selectedReviewEvidence.flagged ? "SEÑALADO" : "NO SEÑALADO"}</dd>
                          </div>
                          <div>
                            <dt>Revisión visual</dt>
                            <dd>{selectedReviewEvidence.reviewHighlighted ? "RESALTADO" : "NO RESALTADO"}</dd>
                          </div>
                        </dl>
                        <details className="analysis-review-technical-details">
                          <summary>Detalles técnicos</summary>
                          <dl className="analysis-review-context-technical">
                            <div><dt>Nivel</dt><dd>{selectedReviewSegment.reviewPresentation?.level ? SIGNAL_LABEL[selectedReviewSegment.reviewPresentation.level] : "Sin nivel"}</dd></div>
                            <div><dt>Umbral del detector</dt><dd>{technicalPercentage(selectedReviewEvidence.threshold)}</dd></div>
                            <div><dt>Umbral visual</dt><dd>{visualThresholdLabel}</dd></div>
                            <div><dt>Modelo</dt><dd>{selectedReviewSegment.modelName}</dd></div>
                            <div><dt>Versión del analizador</dt><dd>{run.analyzerVersion}</dd></div>
                            <div><dt>Perfil del umbral</dt><dd>{run.thresholdProfile}</dd></div>
                            <div><dt>Calibración</dt><dd>{run.modelResults?.map((model) => model.calibration).filter(Boolean).join(" · ") || "No disponible"}</dd></div>
                            <div><dt>Modo</dt><dd>{run.paragraphMode ?? "—"}</dd></div>
                            <div><dt>Tokens</dt><dd>{selectedReviewSegment.tokens ?? "—"}</dd></div>
                            <div><dt>Palabras</dt><dd>{selectedReviewSegment.words ?? "—"}</dd></div>
                            {run.paragraphMode === "CONTEXTUAL_PARAGRAPH" && (
                              <>
                                <div><dt>Contexto previo</dt><dd>{contextTokenLabel(selectedReviewSegment.contextTokensBefore ?? null)}</dd></div>
                                <div><dt>Contexto posterior</dt><dd>{contextTokenLabel(selectedReviewSegment.contextTokensAfter ?? null)}</dd></div>
                              </>
                            )}
                            <div><dt>ID del análisis</dt><dd className="analysis-mono">{run.id}</dd></div>
                            <div><dt>ID del documento</dt><dd className="analysis-mono">{run.documentId ?? documentId}</dd></div>
                            <div><dt>ID del segmento</dt><dd className="analysis-mono">{selectedReviewSegment.id}</dd></div>
                          </dl>
                        </details>
                      </>
                    ) : (
                      <p className="analysis-review-context-empty">Selecciona un párrafo resaltado para ver su señal y estado.</p>
                    )}
                    <details className="analysis-review-technical-details analysis-review-global-details">
                      <summary>Detalles técnicos del análisis</summary>
                      <dl className="analysis-review-context-technical">
                        <div><dt>Señalados por detector</dt><dd>{presentationCounts?.rawFlaggedCount ?? run.flaggedSegments ?? "—"}</dd></div>
                        <div><dt>Excluidos de revisión visual</dt><dd>{presentationCounts?.presentationExcludedFlagged ?? "—"}</dd></div>
                        <div><dt>Umbral del detector</dt><dd>{technicalPercentage(run.threshold ?? null)}</dd></div>
                      </dl>
                    </details>
                  </div>
                </aside>
              </div>
            </>
          )}
        </section>
      )}

      {run?.status === "FAILED" && (
        <p className="analysis-notice analysis-error" role="alert">
          El análisis seleccionado no se completó ({run.errorCode ?? "error"}).
        </p>
      )}

      {run?.status === "COMPLETED" && activeView === "DETAIL" && (
        <div
          className="analysis-detail-view"
          id="analysis-detail-view"
          role="tabpanel"
          aria-labelledby="analysis-tab-detail"
        >
          <div className="analysis-detail-mode" role="group" aria-label="Vista del detalle técnico">
            <span>Vista:</span>
            <button className="button button-quiet" type="button" aria-pressed={detailMode === "GROUPED"} onClick={() => setDetailMode("GROUPED")}>Agrupada</button>
            <button className="button button-quiet" type="button" aria-pressed={detailMode === "SEGMENTS"} onClick={() => setDetailMode("SEGMENTS")}>Segmentos</button>
          </div>
          {detailMode === "GROUPED" ? (
            <>
              {technicalPresentation.isPending && <p className="analysis-notice" role="status">Cargando detalle técnico agrupado…</p>}
              {technicalPresentation.isError && <p className="analysis-notice analysis-error" role="alert">No se pudo cargar el detalle agrupado. <button className="button button-quiet" type="button" onClick={() => void technicalPresentation.refetch()}>Reintentar detalle</button></p>}
              {technicalPresentation.data && !presentationData && <p className="analysis-notice analysis-error" role="alert">El detalle agrupado no corresponde al análisis seleccionado.</p>}
              {presentationData && <TechnicalGroupedDetail presentation={presentationData} onReview={jumpToParagraph} />}
            </>
          ) : <>
      {run?.status === "COMPLETED" && researchMode && (
        <div className="analysis-list-bar">
          <div className="analysis-list-heading">
            <h3>Segmentos del documento</h3>
            <span className="analysis-result-count">
              {totalParagraphs} {totalParagraphs === 1 ? "segmento" : "segmentos"}
            </span>
          </div>
          <div className="analysis-segment-controls">
            <div className="analysis-segment-control">
              <span>Filtrar</span>
              <CustomSelect
                id="analysis-segment-filter"
                label="Filtrar párrafos"
                value={filter}
                options={ANALYSIS_SEGMENT_FILTERS.map((item) => ({
                  value: item,
                  label: item === "ALL"
                    ? "Todos los niveles"
                    : item === "INSUFFICIENT"
                      ? "Texto insuficiente"
                      : SIGNAL_LABEL[item],
                }))}
                onChange={(value) => {
                  setFilter(value as AnalysisSegmentFilter);
                  setPage(1);
                }}
              />
            </div>
            <div className="analysis-segment-control">
              <span>Ordenar</span>
              <CustomSelect
                id="analysis-segment-sort"
                label="Ordenar párrafos"
                value={sort}
                options={[
                  { value: "PARAGRAPH", label: "Orden del documento" },
                  { value: "SCORE_DESC", label: "Señal más alta primero" },
                ]}
                onChange={(value) => {
                  setSort(value as AnalysisSegmentSort);
                  setPage(1);
                }}
              />
            </div>
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
          </>}
        </div>
      )}
    </section>
  );
}

