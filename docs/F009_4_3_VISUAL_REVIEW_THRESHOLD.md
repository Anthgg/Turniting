# F009.4.3 - Universal visual review threshold

## Base y alcance

- Rama: `feat/f009-4-3-visual-review-threshold`.
- Base publicada y verificada: `origin/feat/f009-4-2-review-presentation-hardening`.
- Commit base: `d3da82f9025f65144b71c49e69b2d3a4204468e2`.
- La base contiene `106df73e31428605821fb6b2151282ad41d86c96` (F009.4.1).
- Se ejecutaron status, fetch con prune, inventario de ramas, log de 40 commits y worktree list antes del cambio.
- Trabajo en `C:\Users\anthg\Turniting`; el worktree F008.1 permanece separado e intacto.

La fase cambia la presentación web y PDF. No modifica ai-service, inferencia, entrenamiento, datasets, pesos, calibración, thresholds científicos ni esquema Prisma. No hay migración nueva ni reanálisis de runs históricos. Se conserva el flujo de fuente original, reportes duales, preview, descarga, regeneración y eliminación independiente.

## Dos decisiones independientes

La decisión científica existente conserva su comparación inclusiva contra el threshold real del run. Los scores y clasificaciones persistidos permanecen iguales.

La decisión visual tiene una única autoridad en `backend/src/analysis/review-highlight-policy.ts`:

```ts
REVIEW_HIGHLIGHT_THRESHOLD = 0.20
evaluated === true && Number.isFinite(score) && score > REVIEW_HIGHLIGHT_THRESHOLD
  && presentationExcluded !== true
```

Policy: `f00943-review-gt20-v1`; comparador: `GT`. No usa IDs de modelos, `flagged`, `signalLevel`, calibration o el threshold del detector. No necesita una variable de entorno.

| Score | Revisión visual | Detector con threshold 0.59 |
| --- | --- | --- |
| 0.10 | NO RESALTADO | NO SEÑALADO |
| 0.199999 | NO RESALTADO | NO SEÑALADO |
| 0.20 | NO RESALTADO | NO SEÑALADO |
| 0.200001 | RESALTADO | NO SEÑALADO |
| 0.35 | RESALTADO | NO SEÑALADO |
| 0.58 | RESALTADO | NO SEÑALADO |
| 0.59 | RESALTADO | SEÑALADO |
| 0.83 | RESALTADO | SEÑALADO |

Una referencia/metadata/caption/heading excluida visualmente sigue excluida aunque tenga score alto. `evaluated=false`, score null, NaN o Infinity no producen resaltado. Null conserva su significado de ausencia de score.

## Contrato y web

Los endpoints de segmentos y presentación técnica exponen aditivamente `reviewHighlightThreshold`, `reviewHighlightComparator` y `presentationPolicyVersion`. La evidencia incluye `reviewHighlighted`, y `reviewPresentation.highlight` contiene la misma decisión. Se deriva al leer; no se escribe en AnalysisRun o AnalysisSegment.

El frontend consume la decisión del servidor mediante un helper central y valida score finito, evaluación y exclusiones. No duplica el valor numérico del threshold. Los clientes anteriores pueden seguir leyendo los campos existentes; no se introduce un fallback visual basado en flags científicos.

- `scientificFlaggedCount`/`rawFlaggedCount` cuentan las decisiones del detector, incluidas las excluidas de la presentación.
- `reviewHighlightedCount` cuenta la regla visual. `actionableHighlightCount` es su alias de compatibilidad para navegación.
- `presentationExcludedFlagged` sigue contando flags científicos excluidos; no se obtiene restando el contador visual al científico.
- Los contadores de segmentos son del run completo, independientemente de la paginación o filtro de la lista.
- La navegación anterior/siguiente usa los IDs visuales; los filtros científicos conservan su semántica.
- Detalle agrupado y detalle por segmentos separan Estado del detector de Revisión visual. Cada miembro evaluado conserva score y estado individuales; ningún grupo obtiene score agregado.
- La leyenda indica `>20.0 %`, derivado de la policy devuelta por API.

## Reportes y regeneración

Original Review dibuja solamente overlays sobre las páginas originales. Su portada separa umbral detector, umbral revisión visual, flags científicos y resaltados para revisión. La leyenda explica que el criterio visual es independiente del umbral del modelo. No se imprimen scores locales sobre las páginas fuente.

Technical conserva cada porcentaje local, threshold y estado científico, y añade Revisión visual: RESALTADO/NO RESALTADO para cada segmento evaluado, también dentro de grupos estructurales. Ambos reportes usan el mismo snapshot de fuente y run.

Cada nuevo `ReportArtifact.analysisSnapshot.presentation` registra policy, threshold, comparador, ambos contadores e IDs originales de segmentos resaltados (índices base cero). El objeto científico `run` conserva su contrato; el campo histórico `run.flaggedCount` no se redefine silenciosamente.

Versiones nuevas:

- Original: `f00943-original-review-gt20-v1`.
- Technical: `f00943-paragraph-technical-review-gt20-v1`.
- Mapping: `f00943-source-bound-sequential-mapping-v2`.

El fingerprint del mapa incluye la decisión visual. Las versiones evitan reutilizar PDFs/mapas creados con la regla anterior al generar/regenerar. Los PDFs existentes no se reescriben. La extracción de fuente PDF y conversión DOCX conservan sus versiones y controles de identidad/checksum. `ReportArtifact` continúa prohibido como fuente y permanece cubierta la regresión contra report nesting.

## Validación automática

| Gate | Resultado |
| --- | --- |
| Backend | 278 PASS, 25 archivos |
| Backend e2e | 33 PASS, 4 archivos |
| PDF, subconjunto del backend | 29 PASS, sin skips |
| Frontend | 78 PASS, 14 archivos |
| AI service, regresión existente | 73 PASS, 1 skip existente |
| Backend/frontend build | PASS, host e imágenes Docker |
| Backend/frontend lint | PASS, únicamente avisos preexistentes |
| AI service Ruff | PASS |
| diff --check | PASS |

Backend y e2e se ejecutaron en contenedor temporal con `--network none`, fuentes y manifests existentes montados en solo lectura y dependencias Linux de la imagen. Las pruebas usan mocks y documentos sintéticos. La regresión AI se ejecutó con el Python local existente y modo offline; no entrena ni usa F006/F008 research. La imagen runtime AI no incluye pytest y no se le instalaron dependencias.

Las pruebas cubren los límites estrictos, valores no finitos, insuficientes, exclusiones, independencia del modelo/threshold, paridad de IDs web/PDF, navegación, contadores separados, ausencia de mutaciones científicas, snapshots y regeneración, streams originales y prohibición de anidado.

Hubo fallos iniciales de infraestructura: TEMP del sandbox impidió que Vitest iniciara; se usó TEMP/TMP dentro del debug ignorado. La ejecución Python del sandbox se interrumpió sin resultados y se repitió con permisos normales del host. Los fallos iniciales de expectativas visuales antiguas y del parser de gráficos de la auditoría se corrigieron para verificar la nueva regla; se conservaron las comprobaciones científicas.

## Smoke sintético real

Se subió por UI el fixture compartido `visual-review-threshold-fixture.pdf` (una página, siete párrafos inventados). El script protegido creó un run QA nuevo con scores guardados, sin inferencia ni actualización de fuente o runs existentes.

- Documento: `3c806bdb-b4d4-4d59-bd1b-ece0dda302b7`.
- Versión: `ad18f824-e2c8-4e44-82c0-48fc348efc44`.
- Run: `5e416ea5-3cc3-432b-addd-d2efe7ecdaa0`.
- Fuente SHA-256: `da5872c773d38400377a7cbce378f8729aa1e9201b03cac4351af72050de8f6b`.
- Modelo explícitamente sintético: `SYNTHETIC_F00943_PERSISTED_SCORES`.
- Threshold científico 0.59, global guardado 0.434.
- Flags científicos P6/P7; resaltados P3/P4/P5/P6/P7.

Se completaron generate-both, navegación por los cinco resaltados, previews y descargas de ambos reportes y regeneración de ambas variantes. La web muestra 2 flags y 5 resaltados; el detalle de P3 muestra 21.0%, NO SEÑALADO y RESALTADO.

La auditoría sintética de solo lectura verifica los gráficos realmente dibujados: IDs `[2,3,4,5,6]`, 15 rectángulos; conserva el stream fuente, no añade operadores de texto a las páginas originales y no contiene streams del técnico. Los siete porcentajes y estados técnicos coinciden. Los digests de run, fuente, segmentos y resultados de modelos permanecen iguales. Original: 2 páginas; Technical: 3 páginas. Las cinco páginas se rasterizaron e inspeccionaron sin recortes ni solapamientos.

Artifacts regenerados auditados:

- Original: `9e90b66c-6bc8-4693-97d7-d858d10869bf`.
- Technical: `ab897c41-cc03-44ba-ae29-b93f9698636a`.

El navegador integrado bloqueó dos cargas del visor PDF (`ERR_BLOCKED_BY_CLIENT`). Los previews nativos se verificaron visualmente en Chrome. Ambas consolas tienen cero errores capturados. La captura CDP de red de Chrome fue truncada y no se usa como evidencia completa. El proxy registra 63 solicitudes de los IDs sintéticos: cero HTTP 4xx/5xx y cero Analyze requests. Se conservan esas limitaciones de captura explícitamente.

Evidencias: [auditoría PDF](evidence/f00943/synthetic-report-audit.json), [smoke web](evidence/f00943/browser-smoke.json), [red del proxy](evidence/f00943/synthetic-network.json), [web](evidence/f00943/browser-review.png), [preview original Chrome](evidence/f00943/browser-original-preview.png), [preview técnico Chrome](evidence/f00943/browser-technical-preview.png).

## TESIS: QA manual del run existente

Se usó exclusivamente el run existente identificado por el usuario, mediante regeneración de reportes. No se pulsó Analyze IA. La tesis, sus PDFs, imágenes, texto, identificadores, hashes y scripts de inspección permanecen en almacenamiento local ignorado; no se usan como fixtures automáticos. Solo se versionan métricas agregadas y resultados booleanos de esta comprobación manual.

| Dato | Resultado final |
| --- | --- |
| Global científico | 0.4342228555892896 (43.4%) |
| Threshold científico | 0.59 (59.0%) |
| Threshold visual | >0.20 (>20.0%) |
| Modelo | ENSEMBLE_V2_V3 |
| Segmentos evaluados/insuficientes | 50 / 476 |
| Flags científicos | 4 |
| Resaltados visuales web/PDF | 45 / 45 |
| Rectángulos efectivamente dibujados | 266 / 266 |
| Resaltados parciales/no localizados | 0 / 0 |
| Páginas Original Review | 19: portada + 18 fuente |
| Páginas Technical | 37 |
| Streams/páginas originales preservados | 18 / 18 |
| Streams de texto añadidos al original | 0 |
| Streams técnicos anidados | 0 |
| Referencias resaltadas | 0 de 154 segmentos de referencias |
| Digests científicos/fuente iguales | 5 / 5 |
| PDFs anteriores preservados | 7 / 7, bytes y estados sin cambios |

Las nuevas portadas muestran 43.4%, detector 59.0%, revisión >20.0%, 4 flags y 45 resaltados. La portada original y una página fuente se renderizaron e inspeccionaron manualmente. Los IDs y checksums de estos artifacts se conservan únicamente en el debug ignorado. [Evidencia agregada](evidence/f00943/manual-final-audit.json).

## Avisos y límites

Persisten los avisos previos de lint (`documents.service.ts`, control regex; `AnalysisPanel.tsx`, set-state-in-effect) y de bundle frontend superior a 500 kB. Poppler Windows emitió un aviso de display font Symbol al renderizar el original privado; se conservaron los bytes fuente y se verificó la imagen. No se añadieron dependencias, modelos ni fuentes.

La regla conserva las exclusiones estructurales de F009.4.2; no añade un parser semántico ni reclasifica metadata ambigua. Las mediciones locales no son garantías de rendimiento: una agrupación sintética de siete segmentos midió 0.125 ms y 7,968 bytes de delta heap. Los grupos no agregan scores. Las referencias siguen excluidas solo en presentación, sin recalcular la señal global.

Las comprobaciones son locales. No se crea PR ni se hace merge; la rama solicitada se publica mediante push. Se verificó que origin corresponde a `https://github.com/Anthgg/Turniting.git`, con permiso push del propietario y visibilidad pública. Un primer intento de push fue rechazado por la revisión automática ante posible metadata privada; antes de reintentar se redujo la evidencia manual versionada a agregados sin IDs, nombres privados ni digests, y se comprobó que todas las capturas versionadas pertenecen al fixture sintético. La continuidad F008.1 permanece separada y requiere sus propias instrucciones y gates de datos antes de cualquier experimento.
