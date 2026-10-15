# F002: parser de reportes Turnitin y ground truth

F002 lee reportes PDF exportados y conserva su información visible para revisión y evaluación posteriores. No ejecuta el detector de escritura con IA de Turnitin, no busca fuentes en Internet y no implementa un motor de similitud.

## Flujo

1. NestJS valida extensión, MIME, firma `%PDF-` y tamaño (`MAX_TURNITIN_REPORT_MB`, 30 MB por defecto).
2. `StorageService` guarda el archivo como `turnitin/<uuid>.pdf`; PostgreSQL conserva nombre original, hash SHA-256 y metadatos.
3. FastAPI extrae texto, lee metadatos, tipo de reporte, porcentajes, filtros, fuentes y segmentos con resaltado visible.
4. NestJS persiste el reporte, fuentes y segmentos. Los bytes del PDF no se guardan en PostgreSQL.
5. Un reporte se puede asociar a un `DocumentVersion` extraído. La alineación registra `EXACT`, `HIGH`, `PARTIAL`, `MISMATCH` o `UNVERIFIED`, señales secundarias y offsets sobre el texto original.
6. Un `GroundTruthCase` conserva referencias opcionales/obligatorias según el tipo, datos esperados y una instantánea de resultados actuales.

## Endpoints

Todos los endpoints de NestJS llevan el prefijo `/api`.

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/turnitin/reports` | Cargar un archivo PDF multipart en el campo `file` y analizarlo. |
| GET | `/api/turnitin/reports` | Listar por página; filtros opcionales `reportType` y `status`. |
| GET | `/api/turnitin/reports/:id` | Consultar metadatos, resultados, estado de asociación y conteos. |
| GET | `/api/turnitin/reports/:id/sources` | Consultar fuentes paginadas, incluidos porcentaje raw y tipo. |
| GET | `/api/turnitin/reports/:id/segments` | Consultar segmentos paginados; filtro opcional `segmentType`. |
| POST | `/api/turnitin/reports/:id/reparse` | Volver a analizar el PDF almacenado y reemplazar filas analizadas en una transacción. Si falla el parser, las filas previas se conservan. |
| POST | `/api/turnitin/reports/:id/match` | Asociar a `documentVersionId` y alinear texto extraído. |
| DELETE | `/api/turnitin/reports/:id` | Eliminar el reporte, sus relaciones y el PDF local; no elimina el documento asociado. |
| POST | `/api/turnitin/ground-truth` | Crear caso `AI_REPORT`, `SIMILARITY_REPORT` o `VALIDATION`. |
| GET | `/api/turnitin/ground-truth` | Listar casos paginados. |
| GET | `/api/turnitin/ground-truth/:id` | Consultar el caso completo. |
| PATCH | `/api/turnitin/ground-truth/:id` | Actualizar expectativas/notas y recalcular validación. |

FastAPI ofrece `POST /turnitin/parse` para el parser y `POST /turnitin/align` para el alineador interno. React no llama a FastAPI directamente.

## Campos y criterios

- Tipos: `AI_WRITING`, `SIMILARITY`, `UNKNOWN`.
- Estados: `PARSED`, `PARTIAL`, `OCR_REQUIRED`, `FAILED` (y estados de ciclo de vida `UPLOADED`, `PROCESSING`).
- `requiresOcr` refleja `OCR_REQUIRED`; `submittedAt` y `downloadedAt` son nullable y permanecen vacíos cuando el instante no puede leerse o conocerse con certeza.
- Se conservan porcentajes como texto raw y como número nullable. Por ejemplo, `<1%` permanece raw y su número queda `null` con `percentageIsLessThan=true`.
- Las fuentes incluyen índice, tipo, nombre visible, porcentaje raw/numérico y color. Los segmentos guardan tipo, página, texto visible y normalizado, bbox, color, fuente asociada solo cuando se puede resolver por el reporte, y offsets opcionales.
- Un fragmento no resaltado se clasifica como `NOT_FLAGGED`; eso no demuestra autoría humana ni originalidad.
- Si el PDF tiene poco texto seleccionable, el parser devuelve `OCR_REQUIRED`; no se intenta OCR en F002.
- URLs de fuentes se tratan como texto. No se visitan, consultan ni rastrean.
- La identidad de entrega se calcula aparte de la coincidencia de contenido. IDs de entrega diferentes producen `submissionRelation=DIFFERENT`, pero el contenido se compara independientemente.
- La alineación compara contenido normalizado y usa RapidFuzz cuando está disponible, con fallback a `difflib`. Umbrales centralizados: mínimo 200 caracteres normalizados; `HIGH` desde 0.88, `PARTIAL` desde 0.60; segmento difuso desde 0.78. Conteos cercanos y título aportan señales secundarias.

## Ground truth

`AI_REPORT` requiere `aiReportId`; `SIMILARITY_REPORT` requiere `similarityReportId`; `VALIDATION` permite cualquier subconjunto opcional de referencias a documento y reportes. `expectedData` es opcional y valida un subconjunto exacto de `actualData`; el resultado se guarda como `validationStatus=EXACT` o `MISMATCH`. Si no se proporcionan expectativas, queda `UNVERIFIED`.

Las relaciones de los dos reportes se calculan por separado:

- `submissionRelation`: `SAME`, `DIFFERENT` o `UNKNOWN` según los identificadores visibles.
- `contentMatchStatus`: identidad textual que arroja la alineación; el ID de entrega no sustituye esa comparación.

## Privacidad y límites

- Los reportes reales, el DOCX original y sus textos no se incluyen en Git, fixtures, documentación ni logs.
- Las pruebas automáticas crean reportes PDF sintéticos con PyMuPDF. Los archivos reales solo se usan en QA local privado.
- El parser usa PyMuPDF para lectura; no ejecuta JavaScript del PDF ni abre adjuntos incorporados.
- Los logs registran tipo de error y evento, sin texto del reporte, correo, ORCID o submission ID.
- Los directorios locales de datos y depuración Turnitin están excluidos mediante `.gitignore`.

## Verificación local

Desde cada paquete:

```powershell
# ai-service
.venv\Scripts\ruff.exe check .
.venv\Scripts\python.exe -m pytest -q

# backend
npm run lint
npm test
npm run test:e2e
npm run build

# frontend
npm run lint
npm run build
```

Migración incremental: `backend/prisma/migrations/20261015220405_f002_turnitin_reports`. La base Docker local conserva el volumen existente; no usar `docker compose down -v` para este flujo.
