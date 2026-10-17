type Warnings = {
  hasNonCommercialSources: boolean
  nonCommercial: string[]
  undeclared: string[]
  blocked: string[]
  message: string | null
}

export function LicenseWarning({ warnings }: { warnings: Warnings }) {
  if (!warnings.hasNonCommercialSources && warnings.undeclared.length === 0 && warnings.blocked.length === 0) return null
  return (
    <div className="dataset-license-warning" role="alert">
      <strong>Este dataset/modelo incluye fuentes con restricciones no comerciales.</strong>
      <ul>
        {warnings.nonCommercial.length > 0 && <li>Solo uso no comercial: {warnings.nonCommercial.join(', ')}</li>}
        {warnings.undeclared.length > 0 && <li>Licencia no declarada o desconocida: {warnings.undeclared.join(', ')}</li>}
        {warnings.blocked.length > 0 && <li>Bloqueadas (no utilizadas): {warnings.blocked.join(', ')}</li>}
      </ul>
      <span>Los modelos entrenados con este dataset son de investigación (RESEARCH_ONLY) hasta obtener permisos comerciales.</span>
    </div>
  )
}
