export function technicalPercentage(score: number | null | undefined) {
  return typeof score === "number" && Number.isFinite(score) ? `${(score * 100).toFixed(1)} %` : "NO EVALUADO";
}
