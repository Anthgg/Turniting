# F009.1 — Historial y exportación de reportes IA

F009.1 convierte los artefactos de F009.0 en una experiencia de producción. Los reportes generados por Turniting aparecen en `/reports`; los PDFs externos importados continúan en `/turnitin-reports` bajo la etiqueta **Turnitin importados**.

## API

- `GET /api/reports` lista el historial global. Acepta `documentId`, `type`, `status`, `page` y `pageSize`. El tamaño predeterminado es 20 y el máximo 100. Ordena por `generatedAt` descendente y devuelve `items`, `total`, `page` y `pageSize`.
- `GET /api/documents/:documentId/reports` aplica los mismos filtros y limita los resultados al documento indicado.
- `GET /api/reports/:reportId` devuelve metadatos y un resumen seguro del documento y la corrida. No incluye `storageKey`, rutas locales ni datos de almacenamiento.
- `POST /api/documents/:documentId/reports/ai` genera o reutiliza el reporte IA de una corrida completada.
- `POST /api/reports/:reportId/regenerate` crea un artefacto nuevo desde la corrida original de un reporte IA expirado, eliminado o fallido. Conserva el registro histórico anterior.
- `GET /api/reports/:reportId/download` descarga el PDF mientras esté disponible.
- `DELETE /api/reports/:reportId` elimina el archivo PDF y es idempotente. Conserva el documento, la versión, la corrida y sus resultados.

Las respuestas del historial exponen tamaño, hash, fecha de generación y expiración, nombre del documento, etiqueta de corrida y estado. Los tamaños de reportes F009.0 anteriores a esta migración permanecen nulos; los nuevos se guardan al completar la generación, sin releer el archivo.

## Estados, reutilización y retención

Los estados visibles son `GENERATING`, `AVAILABLE`, `EXPIRED`, `DELETED` y `FAILED`. Los registros legados `ERROR` se presentan como `FAILED`. Los errores de generación muestran la causa genérica «No se pudo generar el PDF. Intenta de nuevo.» y nunca el stack trace.

La retención sigue fija en 24 horas. Una corrida con fingerprint vigente reutiliza el artefacto y registra `REPORT_REUSED`. La regeneración genera nuevo ID, fecha de creación y fecha de expiración; el artefacto anterior permanece como metadata. El estado de expiración se actualiza al consultar el historial, además de la limpieza al inicio y cada hora.

La limpieza agrega `expiredCount`, `deletedFiles`, `missingFiles` y `failedDeletes` en un log JSON. Los logs no incluyen texto documental.

## Auditoría

Se registran `REPORT_GENERATED`, `REPORT_REUSED`, `REPORT_DOWNLOADED`, `REPORT_REGENERATED`, `REPORT_DELETED`, `REPORT_EXPIRED` y `REPORT_FAILED`. El evento de regeneración puede guardar el ID del reporte anterior; ningún evento guarda texto analizado.

## PDF IA

La versión `f0091-report-renderer-v2` presenta documento, fechas y corrida; señal global estimada y nivel; perfil, modo y umbral; distribución de señal alta, moderada, baja e insuficiente; detalle de párrafos y grupos insuficientes; hasta siete corridas anteriores; metodología y limitaciones derivadas de las versiones de modelo vinculadas al run. En modo contextual solo muestra conteos disponibles de tokens vecinos; en modo estricto indica «Solo el párrafo». No imprime el texto de párrafos vecinos.

Cada página incluye Turniting, la leyenda «Reporte independiente», el número de página y el ID corto del artefacto. El PDF conserva el disclaimer que aclara que Turniting no es un reporte oficial de Turnitin ni una prueba de autoría o uso de IA.

## Archivos temporales de smoke

Los tests usan un directorio OS-temp con prefijo exclusivo `turniting-f009-pdf-smoke-`. `cleanupReportSmokeTempFiles` valida su ubicación, rechaza directorios y enlaces, elimina cada archivo regular individualmente y comprueba cero remanentes. La prueba crea siete PDFs sintéticos y verifica la limpieza. No se usa borrado recursivo.

## Límite con F008

El tipo `SIMILARITY_REPORT` y su endpoint permanecen para compatibilidad, pero no se crea un `SimilarityRun` ni se calculan coincidencias. El endpoint informa que el reporte de similitud estará disponible cuando F008 persista su corrida. La integración del PDF de similitud queda pendiente de F008.
