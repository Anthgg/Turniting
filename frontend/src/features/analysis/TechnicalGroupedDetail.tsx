import type { TechnicalPresentation } from "../../api/analysis";
import { technicalPercentage } from "./technical-presentation-utils";
import { isReviewHighlightedDecision, reviewThresholdLabel } from "./review-presentation";

function sourceRange(indices: number[]) {
  if (!indices.length) return "Sin índices";
  const first = indices[0] + 1;
  const last = indices[indices.length - 1] + 1;
  return first === last ? `${first}` : `${first}–${last}`;
}

export function TechnicalGroupedDetail({
  presentation,
  onReview,
}: {
  presentation: TechnicalPresentation;
  onReview: (paragraphIndex: number) => void;
}) {
  return (
    <section className="analysis-grouped-detail" aria-label="Detalle técnico agrupado">
      <p className="analysis-notice">
        {presentation.counts.totalSegments} segmentos detectados · {presentation.counts.evaluatedSegments} evaluados · {presentation.counts.insufficientSegments} insuficientes · {presentation.counts.structuralGroups} grupos estructurales.
        Los porcentajes pertenecen a cada segmento evaluado; los grupos no tienen un score agregado.
      </p>
      <p className="analysis-notice">Umbral de revisión visual: {reviewThresholdLabel(presentation)}. El estado del detector conserva el umbral científico de cada segmento.</p>
      <ol className="analysis-technical-units">
        {presentation.displayUnits.map((unit) => {
          const evaluatedBody = unit.type === "EVALUATED_SEGMENT";
          return (
            <li className={`analysis-technical-unit${evaluatedBody ? " is-evaluated" : " is-structural"}`} key={unit.id} data-display-unit-type={unit.type}>
              <div className="analysis-technical-unit-heading">
                <h4>{unit.label}</h4>
                <small>Segmentos fuente: {sourceRange(unit.sourceSegmentIds)} · {unit.sourceSegmentIds.length} {unit.sourceSegmentIds.length === 1 ? "segmento" : "segmentos"}</small>
              </div>
              {unit.presentationExcluded && <p className="analysis-presentation-excluded">EXCLUIDO DE REVISIÓN VISUAL{unit.excludedReason ? ` · ${unit.excludedReason}` : ""}</p>}
              <p className="analysis-technical-unit-text">{unit.text}</p>
              {unit.evaluatedSegments.length ? (
                <div className="analysis-technical-member-scores" aria-label={evaluatedBody ? "Score del segmento evaluado" : "Scores técnicos internos"}>
                  {!evaluatedBody && <strong>Scores técnicos internos</strong>}
                  {unit.evaluatedSegments.map((member) => (
                    <div key={String(member.sourceSegmentId)} data-source-segment-id={member.sourceSegmentId}>
                      <span>SEGMENTO {member.paragraphIndex + 1} · <b>{technicalPercentage(member.score)}</b> · Detector: {member.flagged ? "SEÑALADO" : "NO SEÑALADO"}{member.threshold !== null ? ` · Umbral del detector ${technicalPercentage(member.threshold)}` : ""} · Revisión: {isReviewHighlightedDecision({ ...member, evaluated: true }) ? "RESALTADO" : "NO RESALTADO"}</span>
                      {member.presentationExcluded && <small>EXCLUIDO DE REVISIÓN VISUAL{member.excludedReason ? ` · ${member.excludedReason}` : ""}</small>}
                      {!member.presentationExcluded && <button className="analysis-text-toggle" type="button" onClick={() => onReview(member.paragraphIndex)}>Ver en Revisión</button>}
                    </div>
                  ))}
                </div>
              ) : <p className="analysis-technical-unit-state">NO EVALUADO · Longitud o estructura insuficiente</p>}
              <details className="analysis-technical-source-trace">
                <summary>Trazabilidad de segmentos fuente</summary>
                <span>Índices persistidos: {unit.sourceSegmentIds.join(", ")}</span>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
