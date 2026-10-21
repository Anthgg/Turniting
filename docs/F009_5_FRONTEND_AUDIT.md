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
