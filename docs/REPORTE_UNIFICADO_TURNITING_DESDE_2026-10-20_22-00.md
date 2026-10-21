# Informe unificado Turniting — F009.4.3 y F009.5

Fecha de corte: 2026-10-21 (America/Lima)
Periodo consolidado: desde el 2026-10-20 a las 22:00 (America/Lima) hasta este cierre.
Rama de trabajo actual: feat/f009-5-quick-analyzer-frontend-redesign
Base de la rama: ef69000ef432b26a2cdd72a18175536084bc9ff5 (F009.4.3).

## Resumen ejecutivo

F009.4.3 separó la decisión científica de la revisión visual y aplicó el criterio visual universal score > 0.20 en las vistas web y en los dos tipos de PDF. Su informe de cierre conserva pruebas sintéticas y métricas agregadas del QA manual solicitado para un run existente; no contiene el texto, PDF, imágenes ni identificadores privados de ese documento.

F009.5 agrega análisis temporal de texto, historial de corridas y configuración técnica, además de una reorganización del frontend por tareas. El endpoint reutiliza el analizador local, devuelve puntaje agregado y señales por párrafo, y no crea documentos, corridas ni reportes. Se mejoró el panel de revisión con contexto lateral en escritorio y panel plegable en móvil. No hubo entrenamiento ni cambios a pesos, datasets, calibración, holdout, umbrales o servicio AI.

## Verificación registrada

- Frontend: 17 archivos de pruebas, 91 tests aprobados; build TypeScript/Vite aprobado con 209 módulos. El bundle JS mide 606.78 kB (169.22 kB gzip) y Vite informa que supera 500 kB. Lint termina con código 0 y una advertencia existente en AnalysisPanel.tsx:155.
- Backend: en esta rama se registraron 272 pruebas aprobadas y 13 omitidas, E2E 35/35 y build aprobado. Lint termina con código 0 y una advertencia existente en documents.service.ts:765.
- Smoke local anterior con dos párrafos sintéticos: puntaje global 94.7%; puntuaciones de párrafo 99.3% y 86.7%; modelo F006.1 Experimental, versión F006_1_SPANISH_GENERALIZATION_EXPERIMENTAL, idioma OTHER. No hubo escrituras: conteos antes/después de documentos/corridas/reportes = 88/119/173. Latencia en frío 58,723 ms; en caliente 1,259 ms.
- El texto enviado no apareció en los logs del servicio AI inspeccionados. Esa revisión no cubre telemetría de proxies o infraestructura externa.
- La inspección visual anterior cubrió seis tamaños de pantalla, pero precede al último ajuste del panel de contexto. El motor Linux de Docker Desktop no estuvo disponible durante la verificación final, y las URLs locales rechazaron conexiones. La revisión visual del último layout queda pendiente; no se afirma PASS posterior a ese ajuste.
- Sin PR ni merge. No se ejecutaron cambios en F006/F008.1. No se incorporaron screenshots, PDFs ni texto de documentos privados.

## Documentos incluidos

Los apéndices reproducen completos los documentos fuente de F009.4.3, auditoría de F009.5 y entrega F009.5. Los documentos F009.5 se actualizaron con los resultados y límites de verificación vigentes al cierre.


---

## Apéndice A — F009.4.3: umbral visual universal

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
`

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



---

## Apéndice B — F009.5: auditoría UX/UI

# F009.5 — Auditoría del frontend antes del rediseño

Fecha: 2026-10-21
Base auditada: `feat/f009-4-3-visual-review-threshold` / `ef69000ef432b26a2cdd72a18175536084bc9ff5`
Entorno: aplicación local Turniting; Docker Compose mostró `frontend`, `backend`, `ai-service` y `db` saludables.

## Cobertura y método

Se contrastaron las rutas del router y los componentes con el grafo de código. Se recorrieron en la aplicación local Inicio, Documentos, una revisión de documento de fixture sintética, Reportes, Modelos, Comparar versiones, Reportes Turnitin y Datasets. La revisión de pantallas no ejecutó análisis ni operaciones que modifiquen datos. Las rutas dinámicas de detalle de datasets y reportes importados se revisaron en su código y contratos; no se capturó ni guardó contenido de documentos privados.

El inventario del grafo contiene 34 archivos bajo `frontend/src` (32 TypeScript y 2 CSS). El router define diez rutas funcionales más el fallback. Los componentes principales están concentrados en `frontend/src/App.tsx`, `frontend/src/features/documents/DocumentDetailPage.tsx`, `frontend/src/features/analysis/AnalysisPanel.tsx` y las páginas de reportes, modelos y datasets.

## CURRENT_STATE

| Ruta actual | Vista y propósito | Observación principal |
|---|---|---|
| `/` | Inicio / actividad reciente | Acciones para subir y comparar, tabla de cinco documentos, tres tarjetas de salud que se actualizan cada 30 s y pie con hitos internos. No hay Análisis rápido ni accesos directos a revisión, reportes o historial. |
| `/documents` | Carga y biblioteca | Uploader y lista paginada conviven en una sola página. La carga soporta PDF, DOCX, TXT, PNG y JPEG; después de cargar el CTA conduce a ver el documento, sin acción directa de analizar. |
| `/documents/:id` | Documento, análisis, revisión y reportes | Una vista grande combina extracción, selección de flujo, análisis, tabs, score, revisión y doble reporte. El panel `AnalysisPanel` presenta controles de modelo, idioma, perfil, modo de párrafo y corrida. |
| `/reports` | Reportes PDF de Turniting | Tabla de diez columnas y nueve casillas de filtro (cinco tipos y cuatro estados, cada grupo incluye «Todos»). La tabla mezcla información útil y técnica, y sus cuatro acciones por fila compiten por espacio. |
| `/turnitin-reports` | Importación y lectura de informes externos | Uploader, texto de privacidad y biblioteca de informes comparten la página. Es una tarea distinta de consultar los reportes PDF generados por Turniting. |
| `/turnitin-reports/:id` | Detalle de informe importado | Vista técnica del informe; revisar en el código para conservar su flujo y separar los detalles avanzados. |
| `/datasets` | Catálogo técnico | Tabla ancha con tamaños, conteos y procedencia/licencias. Su ubicación actual en navegación primaria mezcla administración de investigación con tareas diarias. |
| `/datasets/:id` | Fuentes, artefactos, muestras y estadísticas | Vista de administración técnica; mantener accesible desde Configuración/recursos avanzados, fuera del flujo diario. |
| `/models` | Catálogo y disponibilidad de modelos | Muestra en primer nivel identificadores internos, perfiles, estados experimentales, datos de calibración, métricas y gates. Esta información debe seguir accesible dentro de Detalles técnicos. |
| `/analysis/compare` | Comparación de dos versiones | Cuatro selectores (documento y análisis por versión) son necesarios para elegir qué comparar; conservarlos con etiquetas claras y un diseño compacto. |
| `*` | No encontrado | Fallback existente, sin impacto funcional del rediseño. |

La navegación global actual es un dock fijo inferior. Contiene ocho destinos, incluidos accesos distintos a «Análisis IA» y «Subir»; además, la cabecera tiene otro enlace «Subir». «Análisis IA» apunta al documento activo o al primero de la lista reciente, en vez de abrir una tarea estable. La cabecera también incluye un selector de espacio de trabajo con una única opción y un indicador de entorno local.

## PROBLEMS

- No existen rutas independientes para Análisis rápido, Revisión, Historial o Configuración.
- El inicio da el mismo peso visual a la infraestructura que a la actividad y no propone las dos acciones principales de producto.
- El detalle del documento reúne muchas etapas en una sola vista; el usuario debe entender el selector de ejecución y los controles avanzados antes de revisar el resultado.
- El catálogo de modelos expone identificadores y resultados de investigación como contenido principal.
- La tabla de reportes exige leer muchas columnas y muestra controles repetidos en cada fila; en anchos pequeños no conserva una jerarquía clara.
- La carga, la biblioteca y la actividad reciente se reparten sin un camino directo y corto hasta el análisis.
- No hay una página de preferencias ni un lugar único para el estado técnico.

## REDUNDANT_CONTROLS

- «Subir» aparece en la cabecera y en el dock; el dock además tiene destinos Documentos y Análisis IA que llevan al mismo documento/lista en estados distintos.
- El enlace «Análisis IA» cambia según el documento más reciente, aunque parece una entrada de navegación fija.
- En Reportes hay dos grupos de casillas con una opción «Todos» cada uno; la tabla repite modelo, corrida y score que ya aparecen en el documento.
- En el panel de análisis los controles de modelo, idioma, perfil y modo se exponen en el camino principal aunque el backend ya dispone de valores por defecto.
- En el detalle de revisión hay valores resumidos y métricas repetidas en el panel de segmento y en la lista técnica.

## INFORMATION_HIERARCHY_PROBLEMS

- IDs de modelo, perfiles internos, calibración, corrida, umbrales y estados de serving están a la vista junto con el texto que el usuario revisa.
- El score global, la señal local, el umbral científico y el umbral visual compiten en la misma superficie; necesitan etiquetas y jerarquías separadas.
- El pie del Inicio incluye nombres de fases internas del proyecto que no ayudan a completar una tarea.
- Reportes, datasets y modelos mezclan conceptos de producto con datos de sistema y requieren secciones por tarea.

## NAVIGATION_PROBLEMS

- El dock fijo carece de agrupación por tarea; comparar, analizar, cargar, revisar y administrar investigación aparecen al mismo nivel.
- La navegación no indica dónde viven revisión, historial ni preferencias; los reportes generados y los importados tienen nombres parecidos.
- El estado activo de `/analysis/*` se clasifica como «Comparar versiones»; una ruta nueva `/analysis/quick` necesitará título, breadcrumb y navegación propios.
- El layout consulta documentos recientes y el documento activo desde rutas distintas, lo que acopla elementos de navegación al contenido documental.

## RESPONSIVE_PROBLEMS

- En escritorio, el dock flotante y fijo ocupa ancho y se oculta el texto de los ocho destinos; el contenido principal no limita su ancho.
- En móvil, el dock distribuye ocho elementos en una sola barra y reduce las etiquetas a 9 px. No hay drawer con grupos ni sidebar colapsable.
- Tablas de reportes, datasets y modelos tienen muchas columnas; el desplazamiento horizontal no sustituye una vista de tarjetas o filas adaptadas.
- Las páginas con panel de revisión y contexto necesitan pasar a una columna y un panel inferior colapsable en móvil.

## QUICK_WINS

1. Reorganizar la navegación por Inicio, Analizar, Resultados y Configuración, conservando cada destino actual.
2. Hacer que Inicio muestre dos acciones claras: Analizar documento y Análisis rápido, además de actividad reciente compacta.
3. Mover modelo manual, idioma, perfil y modo a Opciones avanzadas; mantener la elección de corrida en la vista donde se abre historial de análisis.
4. Separar la vista principal de revisión y el detalle técnico; mantener disponible la información completa detrás de «Detalles técnicos».
5. Reagrupar la lista de reportes en filas responsivas con tipo, documento, fecha, estado y acciones; pasar IDs y modelo a detalles.
6. Mantener compatibles las rutas existentes y añadir redirecciones solo si una ruta realmente cambia.

## REDESIGN_PLAN

- Introducir una sidebar compacta y colapsable en escritorio con texto e iconos; en móvil usar drawer accesible con cierre por Escape.
- Crear rutas `/analysis/quick`, `/settings`, `/settings/models` y `/settings/system`; dejar alias/redirecciones para conservar enlaces.
- Convertir `/reports` en Historial de reportes y ofrecer el detalle técnico desde cada fila; mantener el flujo separado de informes externos.
- Conservar comparación y administración de datasets, moviendo las tareas técnicas fuera de navegación primaria.
- Usar ancho útil con contenedores y grillas de dos columnas cuando el contenido lo permita; adaptar a una columna en tablet estrecha y móvil.
- Crear componentes compartidos de encabezado, estado, panel, estado vacío/error/carga, drawer, pestañas y tarjeta de resultado donde reduzcan duplicación real.
- No cambiar scores, inferencia, modelos, pesos, umbrales científicos ni el umbral visual existente. La nueva página rápida debe mostrar las decisiones devueltas por el backend y reutilizar sus políticas.
- Validar antes/después con datos sintéticos; no guardar capturas ni documentos privados. Mantener análisis documental, revisión, reportes dobles, historial y página de modelos accesibles.

## Cierre de implementación F009.5

La implementación añadió `/analysis/quick` para análisis temporal sin guardar texto ni crear documentos, corridas o reportes; reorganizó la navegación por tareas y la página de inicio; adaptó documentos y reportes; incorporó Historial y Configuración; y mantuvo accesibles los catálogos de modelos y datasets. En revisión documental, el detalle del párrafo seleccionado pasó a un panel contextual separado: dos columnas en escritorio y panel inferior plegable en pantallas estrechas. Los metadatos avanzados quedan dentro de «Detalles técnicos».

El endpoint rápido reutiliza el análisis local existente y devuelve el puntaje agregado del evaluador junto con señales y umbrales, además de los resultados por párrafo; no guarda la entrada ni crea artefactos de historial. No se modificaron entrenamiento, pesos, datasets, calibración, holdout, scores científicos ni umbrales.

## Verificación final y límites

- Frontend: 17 archivos de prueba, 91 tests aprobados; build TypeScript/Vite aprobado con 209 módulos; lint con salida 0 y una advertencia ya existente en `AnalysisPanel.tsx:155`.
- Backend: 272 pruebas aprobadas y 13 omitidas; E2E 35/35; build aprobado; lint con salida 0 y una advertencia ya existente en `documents.service.ts:765`.
- El smoke de análisis rápido registrado usó únicamente dos párrafos sintéticos, respondió por la ruta local y dejó sin cambios los conteos de documentos, corridas y reportes. No se guardó texto del formulario.
- La inspección visual de seis tamaños de pantalla corresponde a la revisión anterior del layout. No se repitió después del cambio final del panel de contexto: Docker Desktop no pudo iniciar el motor Linux y las URLs locales rechazaron conexiones. Por tanto, la validación visual del layout final queda pendiente; no se afirma PASS para esa revisión.
- No se capturó ni incorporó contenido de documentos privados. Sin PR ni merge.




---

## Apéndice C — F009.5: quick analyzer y rediseño frontend

# F009.5 — Quick text analyzer and frontend redesign

## Scope

This phase adds a quick, temporary text analysis flow and reorganizes the existing frontend around the user’s main tasks. The initial route and interface audit is recorded in [F009_5_FRONTEND_AUDIT.md](./F009_5_FRONTEND_AUDIT.md).

The change preserves the existing document analysis and review, both report libraries, version comparison, model catalog, and dataset catalog. It does not change training, model weights, calibration, datasets, research scores, scientific thresholds, or holdout handling.

## Navigation and page hierarchy

The workspace uses grouped navigation for **Inicio**, **Analizar**, **Resultados**, and **Configuración**. On desktop the sidebar can collapse to an icon rail; at tablet widths it becomes a compact rail; on mobile it opens as a drawer with Escape dismissal, focus containment, focus return, and a backdrop.

The home page puts document analysis and quick text analysis first, followed by recent documents. Service health and the project phase footer live on the technical status page. Existing routes remain reachable:

| Route | Purpose |
| --- | --- |
| `/` | Main actions and recent documents |
| `/documents` | Upload and document library |
| `/analysis/quick` | Temporary pasted-text analysis |
| `/documents/:id` | Document review and existing analysis controls |
| `/reports` | Turniting-generated report library |
| `/history` | Analysis run history |
| `/turnitin-reports` and `/turnitin-reports/:id` | Imported Turnitin reports |
| `/analysis/compare` | Compare document analyses |
| `/models` | Model catalog and technical model information |
| `/datasets` and `/datasets/:id` | Dataset catalog and detail |
| `/settings` | Local service status |

The legacy paths `/settings/system` and `/settings/models` redirect to `/settings` and `/models`, respectively.

## Quick text flow

The page keeps input only in component memory. It does not autosave, create a document, create a report, or add a history entry. The user starts one inference with the button or Ctrl/Cmd+Enter; typing does not call the analyzer. Clearing the input also clears the result. Input is limited to 20,000 characters as counted by JavaScript `String.length`, with a live word and character count, loading state, and scoped error messages.

The browser sends `{ text }` to `POST /api/analysis/quick`. The backend resolves the configured preferred local analyzer and invokes the existing paragraph inference service in `BALANCED` and `STRICT_PARAGRAPH` modes. The response includes the aggregate evaluator score and its scientific/review flags, thresholds and model/language/latency metadata, plus per-paragraph status, calibrated score, scientific flag, and review-highlight flag. It does not return the input, its hash, or character offsets. No document, analysis-run, segment, report-artifact, or comparison writes are performed by this endpoint.

Insufficient paragraphs have `score: null`, `scientificFlag: null`, and render as **No evaluado**. The scientific flag follows the configured scientific decision. Visual review highlighting uses the existing `REVIEW_HIGHLIGHT_THRESHOLD` and a strict `score > threshold` comparison; the default 20% review threshold remains separate from the scientific threshold. The interface explains both signals and puts model/version, language, and latency in expandable analysis details. There is no user-facing model selector.

## Responsive and accessibility behavior

Document review now uses a split workspace on desktop: the text and highlighted paragraphs remain in the main column while the selected paragraph's signal, review state, global signal, and highlight count stay in a contextual panel. On narrow screens that context collapses into a bottom sheet; selecting a highlighted paragraph or moving between highlights opens it, and Escape closes it. Analyzer version, threshold profile, calibration labels, run/document/segment IDs, and related diagnostics remain under collapsed technical details.

- Desktop: compact, grouped, collapsible navigation with text labels and tooltips in the collapsed rail.
- Tablet: persistent icon rail to preserve page width.
- Mobile: drawer with labelled toggle, modal semantics, backdrop, Escape close, focus trap, and focus return; the underlying page is inert while open.
- Pages: flexible content widths, stacked quick-analysis cards on narrow screens, visible focus indicators, reduced-motion support, labelled text input, live loading status, and `No evaluado` rather than a fabricated zero.
- Review: desktop split context panel and a collapsible mobile bottom sheet, with keyboard dismissal and technical diagnostics behind disclosure.

## Verification record

This section is updated after integrated verification. Test text and result fixtures are synthetic. No private document contents or screenshots are committed.

| Check | Result |
| --- | --- |
| Quick analyzer frontend tests | PASS: synthetic QuickAnalysisPage and helper tests included in the full suite. |
| Frontend suite | PASS: 17 files / 91 tests. Vitest required `TEMP`/`TMP` to point inside the workspace because the sandbox denied writes to the default Windows temp directory. |
| Frontend production build | PASS: TypeScript and Vite build; 209 modules. Output: CSS 92.73 kB and JS 606.78 kB (169.22 kB gzip). Vite reports the JS chunk exceeds 500 kB. |
| Frontend lint | PASS with one existing warning: `AnalysisPanel.tsx:155` (`react(set-state-in-effect)`). |
| Backend quick-analysis unit tests | PASS: 5/5 focused tests. |
| Backend suite and E2E route check | PASS: unit suite 272 passed / 13 skipped (25 files); E2E 35/35 across 4 files; Nest build succeeds. Lint exits 0 with one existing warning in `documents.service.ts:765`. |
| AI service tests | Not rerun in F009.5 because no AI-service code changed. The recorded F009.4.3 result is 73 passed / 1 skipped and Ruff passes; a separate F009.5 attempt stalled at `tests/test_analyze.py::test_analyze_test_returns_text_metrics` and was interrupted. |
| Runtime quick-analysis smoke | PASS earlier with two synthetic paragraphs only: global score 94.7%, AI signal, review suggested above 20%, paragraph scores 99.3% and 86.7%; model `F006.1 Experimental`, version `F006_1_SPANISH_GENERALIZATION_EXPERIMENTAL`, language `OTHER`. Nest to local AI service returned a response and did not create Documents, AnalysisRuns, or ReportArtifacts; database counts were unchanged at 88 / 119 / 173. Cold request: 58,723 ms; warm request: 1,259 ms. The submitted phrase was absent from inspected AI-service logs; this does not cover external infrastructure/proxy telemetry. |
| Responsive browser review | PARTIAL: the earlier six viewport and mobile-drawer review predates the final Review context-panel adjustment. Post-adjustment visual verification is blocked because Docker Desktop's Linux engine is unavailable (`dockerDesktopLinuxEngine` pipe not found), and local app URLs refuse connections. No post-adjustment browser PASS is claimed. |
| Git / branch / push | Final review and publication of `feat/f009-5-quick-analyzer-frontend-redesign` are pending. No PR or merge is part of this phase. |

## Final Review-context presentation

The final revision places paragraph review content and context side by side on desktop. The contextual panel reports the global signal and highlight count plus the selected paragraph's signal, detector state, and review state. On mobile it becomes a collapsible bottom sheet. Technical IDs, analyzer version, threshold profile, calibration details, and related metadata are available in a closed-by-default disclosure. Structural tests and TypeScript checks pass; visual behavior at the final breakpoint layout was not rechecked in a live browser because the local runtime was unavailable.


---

## Apéndice A — F009.4.3: umbral visual universal

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
`

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


---

## Apéndice B — F009.5: auditoría UX/UI

# F009.5 — Auditoría del frontend antes del rediseño

Fecha: 2026-10-21
Base auditada: `feat/f009-4-3-visual-review-threshold` / `ef69000ef432b26a2cdd72a18175536084bc9ff5`
Entorno: aplicación local Turniting; Docker Compose mostró `frontend`, `backend`, `ai-service` y `db` saludables.

## Cobertura y método

Se contrastaron las rutas del router y los componentes con el grafo de código. Se recorrieron en la aplicación local Inicio, Documentos, una revisión de documento de fixture sintética, Reportes, Modelos, Comparar versiones, Reportes Turnitin y Datasets. La revisión de pantallas no ejecutó análisis ni operaciones que modifiquen datos. Las rutas dinámicas de detalle de datasets y reportes importados se revisaron en su código y contratos; no se capturó ni guardó contenido de documentos privados.

El inventario del grafo contiene 34 archivos bajo `frontend/src` (32 TypeScript y 2 CSS). El router define diez rutas funcionales más el fallback. Los componentes principales están concentrados en `frontend/src/App.tsx`, `frontend/src/features/documents/DocumentDetailPage.tsx`, `frontend/src/features/analysis/AnalysisPanel.tsx` y las páginas de reportes, modelos y datasets.

## CURRENT_STATE

| Ruta actual | Vista y propósito | Observación principal |
|---|---|---|
| `/` | Inicio / actividad reciente | Acciones para subir y comparar, tabla de cinco documentos, tres tarjetas de salud que se actualizan cada 30 s y pie con hitos internos. No hay Análisis rápido ni accesos directos a revisión, reportes o historial. |
| `/documents` | Carga y biblioteca | Uploader y lista paginada conviven en una sola página. La carga soporta PDF, DOCX, TXT, PNG y JPEG; después de cargar el CTA conduce a ver el documento, sin acción directa de analizar. |
| `/documents/:id` | Documento, análisis, revisión y reportes | Una vista grande combina extracción, selección de flujo, análisis, tabs, score, revisión y doble reporte. El panel `AnalysisPanel` presenta controles de modelo, idioma, perfil, modo de párrafo y corrida. |
| `/reports` | Reportes PDF de Turniting | Tabla de diez columnas y nueve casillas de filtro (cinco tipos y cuatro estados, cada grupo incluye «Todos»). La tabla mezcla información útil y técnica, y sus cuatro acciones por fila compiten por espacio. |
| `/turnitin-reports` | Importación y lectura de informes externos | Uploader, texto de privacidad y biblioteca de informes comparten la página. Es una tarea distinta de consultar los reportes PDF generados por Turniting. |
| `/turnitin-reports/:id` | Detalle de informe importado | Vista técnica del informe; revisar en el código para conservar su flujo y separar los detalles avanzados. |
| `/datasets` | Catálogo técnico | Tabla ancha con tamaños, conteos y procedencia/licencias. Su ubicación actual en navegación primaria mezcla administración de investigación con tareas diarias. |
| `/datasets/:id` | Fuentes, artefactos, muestras y estadísticas | Vista de administración técnica; mantener accesible desde Configuración/recursos avanzados, fuera del flujo diario. |
| `/models` | Catálogo y disponibilidad de modelos | Muestra en primer nivel identificadores internos, perfiles, estados experimentales, datos de calibración, métricas y gates. Esta información debe seguir accesible dentro de Detalles técnicos. |
| `/analysis/compare` | Comparación de dos versiones | Cuatro selectores (documento y análisis por versión) son necesarios para elegir qué comparar; conservarlos con etiquetas claras y un diseño compacto. |
| `*` | No encontrado | Fallback existente, sin impacto funcional del rediseño. |

La navegación global actual es un dock fijo inferior. Contiene ocho destinos, incluidos accesos distintos a «Análisis IA» y «Subir»; además, la cabecera tiene otro enlace «Subir». «Análisis IA» apunta al documento activo o al primero de la lista reciente, en vez de abrir una tarea estable. La cabecera también incluye un selector de espacio de trabajo con una única opción y un indicador de entorno local.

## PROBLEMS

- No existen rutas independientes para Análisis rápido, Revisión, Historial o Configuración.
- El inicio da el mismo peso visual a la infraestructura que a la actividad y no propone las dos acciones principales de producto.
- El detalle del documento reúne muchas etapas en una sola vista; el usuario debe entender el selector de ejecución y los controles avanzados antes de revisar el resultado.
- El catálogo de modelos expone identificadores y resultados de investigación como contenido principal.
- La tabla de reportes exige leer muchas columnas y muestra controles repetidos en cada fila; en anchos pequeños no conserva una jerarquía clara.
- La carga, la biblioteca y la actividad reciente se reparten sin un camino directo y corto hasta el análisis.
- No hay una página de preferencias ni un lugar único para el estado técnico.

## REDUNDANT_CONTROLS

- «Subir» aparece en la cabecera y en el dock; el dock además tiene destinos Documentos y Análisis IA que llevan al mismo documento/lista en estados distintos.
- El enlace «Análisis IA» cambia según el documento más reciente, aunque parece una entrada de navegación fija.
- En Reportes hay dos grupos de casillas con una opción «Todos» cada uno; la tabla repite modelo, corrida y score que ya aparecen en el documento.
- En el panel de análisis los controles de modelo, idioma, perfil y modo se exponen en el camino principal aunque el backend ya dispone de valores por defecto.
- En el detalle de revisión hay valores resumidos y métricas repetidas en el panel de segmento y en la lista técnica.

## INFORMATION_HIERARCHY_PROBLEMS

- IDs de modelo, perfiles internos, calibración, corrida, umbrales y estados de serving están a la vista junto con el texto que el usuario revisa.
- El score global, la señal local, el umbral científico y el umbral visual compiten en la misma superficie; necesitan etiquetas y jerarquías separadas.
- El pie del Inicio incluye nombres de fases internas del proyecto que no ayudan a completar una tarea.
- Reportes, datasets y modelos mezclan conceptos de producto con datos de sistema y requieren secciones por tarea.

## NAVIGATION_PROBLEMS

- El dock fijo carece de agrupación por tarea; comparar, analizar, cargar, revisar y administrar investigación aparecen al mismo nivel.
- La navegación no indica dónde viven revisión, historial ni preferencias; los reportes generados y los importados tienen nombres parecidos.
- El estado activo de `/analysis/*` se clasifica como «Comparar versiones»; una ruta nueva `/analysis/quick` necesitará título, breadcrumb y navegación propios.
- El layout consulta documentos recientes y el documento activo desde rutas distintas, lo que acopla elementos de navegación al contenido documental.

## RESPONSIVE_PROBLEMS

- En escritorio, el dock flotante y fijo ocupa ancho y se oculta el texto de los ocho destinos; el contenido principal no limita su ancho.
- En móvil, el dock distribuye ocho elementos en una sola barra y reduce las etiquetas a 9 px. No hay drawer con grupos ni sidebar colapsable.
- Tablas de reportes, datasets y modelos tienen muchas columnas; el desplazamiento horizontal no sustituye una vista de tarjetas o filas adaptadas.
- Las páginas con panel de revisión y contexto necesitan pasar a una columna y un panel inferior colapsable en móvil.

## QUICK_WINS

1. Reorganizar la navegación por Inicio, Analizar, Resultados y Configuración, conservando cada destino actual.
2. Hacer que Inicio muestre dos acciones claras: Analizar documento y Análisis rápido, además de actividad reciente compacta.
3. Mover modelo manual, idioma, perfil y modo a Opciones avanzadas; mantener la elección de corrida en la vista donde se abre historial de análisis.
4. Separar la vista principal de revisión y el detalle técnico; mantener disponible la información completa detrás de «Detalles técnicos».
5. Reagrupar la lista de reportes en filas responsivas con tipo, documento, fecha, estado y acciones; pasar IDs y modelo a detalles.
6. Mantener compatibles las rutas existentes y añadir redirecciones solo si una ruta realmente cambia.

## REDESIGN_PLAN

- Introducir una sidebar compacta y colapsable en escritorio con texto e iconos; en móvil usar drawer accesible con cierre por Escape.
- Crear rutas `/analysis/quick`, `/settings`, `/settings/models` y `/settings/system`; dejar alias/redirecciones para conservar enlaces.
- Convertir `/reports` en Historial de reportes y ofrecer el detalle técnico desde cada fila; mantener el flujo separado de informes externos.
- Conservar comparación y administración de datasets, moviendo las tareas técnicas fuera de navegación primaria.
- Usar ancho útil con contenedores y grillas de dos columnas cuando el contenido lo permita; adaptar a una columna en tablet estrecha y móvil.
- Crear componentes compartidos de encabezado, estado, panel, estado vacío/error/carga, drawer, pestañas y tarjeta de resultado donde reduzcan duplicación real.
- No cambiar scores, inferencia, modelos, pesos, umbrales científicos ni el umbral visual existente. La nueva página rápida debe mostrar las decisiones devueltas por el backend y reutilizar sus políticas.
- Validar antes/después con datos sintéticos; no guardar capturas ni documentos privados. Mantener análisis documental, revisión, reportes dobles, historial y página de modelos accesibles.

## Cierre de implementación F009.5

La implementación añadió `/analysis/quick` para análisis temporal sin guardar texto ni crear documentos, corridas o reportes; reorganizó la navegación por tareas y la página de inicio; adaptó documentos y reportes; incorporó Historial y Configuración; y mantuvo accesibles los catálogos de modelos y datasets. En revisión documental, el detalle del párrafo seleccionado pasó a un panel contextual separado: dos columnas en escritorio y panel inferior plegable en pantallas estrechas. Los metadatos avanzados quedan dentro de «Detalles técnicos».

El endpoint rápido reutiliza el análisis local existente y devuelve el puntaje agregado del evaluador junto con señales y umbrales, además de los resultados por párrafo; no guarda la entrada ni crea artefactos de historial. No se modificaron entrenamiento, pesos, datasets, calibración, holdout, scores científicos ni umbrales.

## Verificación final y límites

- Frontend: 17 archivos de prueba, 91 tests aprobados; build TypeScript/Vite aprobado con 209 módulos; lint con salida 0 y una advertencia ya existente en `AnalysisPanel.tsx:155`.
- Backend: 272 pruebas aprobadas y 13 omitidas; E2E 35/35; build aprobado; lint con salida 0 y una advertencia ya existente en `documents.service.ts:765`.
- El smoke de análisis rápido registrado usó únicamente dos párrafos sintéticos, respondió por la ruta local y dejó sin cambios los conteos de documentos, corridas y reportes. No se guardó texto del formulario.
- La inspección visual de seis tamaños de pantalla corresponde a la revisión anterior del layout. No se repitió después del cambio final del panel de contexto: Docker Desktop no pudo iniciar el motor Linux y las URLs locales rechazaron conexiones. Por tanto, la validación visual del layout final queda pendiente; no se afirma PASS para esa revisión.
- No se capturó ni incorporó contenido de documentos privados. Sin PR ni merge.


---

## Apéndice C — F009.5: quick analyzer y rediseño frontend

# F009.5 — Quick text analyzer and frontend redesign

## Scope

This phase adds a quick, temporary text analysis flow and reorganizes the existing frontend around the user’s main tasks. The initial route and interface audit is recorded in [F009_5_FRONTEND_AUDIT.md](./F009_5_FRONTEND_AUDIT.md).

The change preserves the existing document analysis and review, both report libraries, version comparison, model catalog, and dataset catalog. It does not change training, model weights, calibration, datasets, research scores, scientific thresholds, or holdout handling.

## Navigation and page hierarchy

The workspace uses grouped navigation for **Inicio**, **Analizar**, **Resultados**, and **Configuración**. On desktop the sidebar can collapse to an icon rail; at tablet widths it becomes a compact rail; on mobile it opens as a drawer with Escape dismissal, focus containment, focus return, and a backdrop.

The home page puts document analysis and quick text analysis first, followed by recent documents. Service health and the project phase footer live on the technical status page. Existing routes remain reachable:

| Route | Purpose |
| --- | --- |
| `/` | Main actions and recent documents |
| `/documents` | Upload and document library |
| `/analysis/quick` | Temporary pasted-text analysis |
| `/documents/:id` | Document review and existing analysis controls |
| `/reports` | Turniting-generated report library |
| `/history` | Analysis run history |
| `/turnitin-reports` and `/turnitin-reports/:id` | Imported Turnitin reports |
| `/analysis/compare` | Compare document analyses |
| `/models` | Model catalog and technical model information |
| `/datasets` and `/datasets/:id` | Dataset catalog and detail |
| `/settings` | Local service status |

The legacy paths `/settings/system` and `/settings/models` redirect to `/settings` and `/models`, respectively.

## Quick text flow

The page keeps input only in component memory. It does not autosave, create a document, create a report, or add a history entry. The user starts one inference with the button or Ctrl/Cmd+Enter; typing does not call the analyzer. Clearing the input also clears the result. Input is limited to 20,000 characters as counted by JavaScript `String.length`, with a live word and character count, loading state, and scoped error messages.

The browser sends `{ text }` to `POST /api/analysis/quick`. The backend resolves the configured preferred local analyzer and invokes the existing paragraph inference service in `BALANCED` and `STRICT_PARAGRAPH` modes. The response includes the aggregate evaluator score and its scientific/review flags, thresholds and model/language/latency metadata, plus per-paragraph status, calibrated score, scientific flag, and review-highlight flag. It does not return the input, its hash, or character offsets. No document, analysis-run, segment, report-artifact, or comparison writes are performed by this endpoint.

Insufficient paragraphs have `score: null`, `scientificFlag: null`, and render as **No evaluado**. The scientific flag follows the configured scientific decision. Visual review highlighting uses the existing `REVIEW_HIGHLIGHT_THRESHOLD` and a strict `score > threshold` comparison; the default 20% review threshold remains separate from the scientific threshold. The interface explains both signals and puts model/version, language, and latency in expandable analysis details. There is no user-facing model selector.

## Responsive and accessibility behavior

Document review now uses a split workspace on desktop: the text and highlighted paragraphs remain in the main column while the selected paragraph's signal, review state, global signal, and highlight count stay in a contextual panel. On narrow screens that context collapses into a bottom sheet; selecting a highlighted paragraph or moving between highlights opens it, and Escape closes it. Analyzer version, threshold profile, calibration labels, run/document/segment IDs, and related diagnostics remain under collapsed technical details.

- Desktop: compact, grouped, collapsible navigation with text labels and tooltips in the collapsed rail.
- Tablet: persistent icon rail to preserve page width.
- Mobile: drawer with labelled toggle, modal semantics, backdrop, Escape close, focus trap, and focus return; the underlying page is inert while open.
- Pages: flexible content widths, stacked quick-analysis cards on narrow screens, visible focus indicators, reduced-motion support, labelled text input, live loading status, and `No evaluado` rather than a fabricated zero.
- Review: desktop split context panel and a collapsible mobile bottom sheet, with keyboard dismissal and technical diagnostics behind disclosure.

## Verification record

This section is updated after integrated verification. Test text and result fixtures are synthetic. No private document contents or screenshots are committed.

| Check | Result |
| --- | --- |
| Quick analyzer frontend tests | PASS: synthetic QuickAnalysisPage and helper tests included in the full suite. |
| Frontend suite | PASS: 17 files / 91 tests. Vitest required `TEMP`/`TMP` to point inside the workspace because the sandbox denied writes to the default Windows temp directory. |
| Frontend production build | PASS: TypeScript and Vite build; 209 modules. Output: CSS 92.73 kB and JS 606.78 kB (169.22 kB gzip). Vite reports the JS chunk exceeds 500 kB. |
| Frontend lint | PASS with one existing warning: `AnalysisPanel.tsx:155` (`react(set-state-in-effect)`). |
| Backend quick-analysis unit tests | PASS: 5/5 focused tests. |
| Backend suite and E2E route check | PASS: unit suite 272 passed / 13 skipped (25 files); E2E 35/35 across 4 files; Nest build succeeds. Lint exits 0 with one existing warning in `documents.service.ts:765`. |
| AI service tests | Not rerun in F009.5 because no AI-service code changed. The recorded F009.4.3 result is 73 passed / 1 skipped and Ruff passes; a separate F009.5 attempt stalled at `tests/test_analyze.py::test_analyze_test_returns_text_metrics` and was interrupted. |
| Runtime quick-analysis smoke | PASS earlier with two synthetic paragraphs only: global score 94.7%, AI signal, review suggested above 20%, paragraph scores 99.3% and 86.7%; model `F006.1 Experimental`, version `F006_1_SPANISH_GENERALIZATION_EXPERIMENTAL`, language `OTHER`. Nest to local AI service returned a response and did not create Documents, AnalysisRuns, or ReportArtifacts; database counts were unchanged at 88 / 119 / 173. Cold request: 58,723 ms; warm request: 1,259 ms. The submitted phrase was absent from inspected AI-service logs; this does not cover external infrastructure/proxy telemetry. |
| Responsive browser review | PARTIAL: the earlier six viewport and mobile-drawer review predates the final Review context-panel adjustment. Post-adjustment visual verification is blocked because Docker Desktop's Linux engine is unavailable (`dockerDesktopLinuxEngine` pipe not found), and local app URLs refuse connections. No post-adjustment browser PASS is claimed. |
| Git / branch / push | Final review and publication of `feat/f009-5-quick-analyzer-frontend-redesign` are pending. No PR or merge is part of this phase. |

## Final Review-context presentation

The final revision places paragraph review content and context side by side on desktop. The contextual panel reports the global signal and highlight count plus the selected paragraph's signal, detector state, and review state. On mobile it becomes a collapsible bottom sheet. Technical IDs, analyzer version, threshold profile, calibration details, and related metadata are available in a closed-by-default disclosure. Structural tests and TypeScript checks pass; visual behavior at the final breakpoint layout was not rechecked in a live browser because the local runtime was unavailable.
