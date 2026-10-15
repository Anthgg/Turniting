# F001 · Ingesta de documentos

## Alcance

F001 carga PDF, DOCX y TXT desde React a NestJS, almacena el original en el filesystem local, extrae texto por FastAPI y persiste metadatos y el texto extraído en PostgreSQL local. No implementa análisis de IA, parser de informes Turnitin, similitud ni OCR real.

`SUPABASE = DEFERRED_TO_F011`

`CLOUD_RUN = DEFERRED_TO_F011`

## Flujo

1. La interfaz valida extensión y tamaño para orientar al usuario y envía `multipart/form-data` a `POST /api/documents`.
2. NestJS valida extensión, MIME, firma y límite de tamaño, genera UUID y SHA-256 y guarda el archivo mediante `StorageService`.
3. NestJS registra el documento y su versión inicial; el binario no se almacena en la base de datos.
4. NestJS reenvía el archivo a `POST /extract` de FastAPI.
5. FastAPI extrae y normaliza el texto; NestJS guarda texto y métricas. Los PDF probablemente escaneados quedan en `OCR_REQUIRED`; no se les aplica OCR.

Los duplicados se guardan como documentos independientes y comparten SHA-256. Los nombres físicos son UUID y el nombre original se conserva solo como metadato.

## Formatos y límites

- Formatos: PDF (`%PDF`), DOCX (paquete ZIP Office válido) y TXT UTF-8/BOM o con fallback de decodificación.
- Rechazar extensiones/MIME/firma incompatibles, archivos corruptos y formatos no admitidos.
- `MAX_UPLOAD_MB` es 20 por defecto. El backend devuelve HTTP 413 con `code: FILE_TOO_LARGE` cuando se supera.
- Nginx acepta hasta 25 MB para dejar margen al envoltorio multipart; el backend aplica el límite estricto de 20 MB.
- `VITE_MAX_UPLOAD_MB` configura el límite mostrado por el frontend.

## Extracción

- PDF: PyMuPDF devuelve texto y número de páginas.
- DOCX: python-docx extrae párrafos y tablas; `pageCount` es `null` porque DOCX no contiene un número fijo de páginas.
- TXT: decodifica UTF-8 y BOM con fallback conservador.
- La normalización preserva contenido y espacios de forma conservadora.
- `wordCount` cuenta tokens Unicode separados por espacios en blanco; `characterCount` es `len(normalized_text)`, incluidos los espacios.
- `OCR_MIN_CHARS_PER_PAGE` y `OCR_MIN_LOW_TEXT_PAGE_RATIO` permiten marcar un PDF probablemente escaneado. La detección no ejecuta OCR.

## Estados

`UPLOADED`, `PROCESSING`, `EXTRACTED`, `OCR_REQUIRED`, `FAILED`.

## API de documentos

Todas las rutas están bajo `/api` en NestJS:

- `POST /documents`: carga multipart del campo `file`.
- `GET /documents?page=1&pageSize=20`: listado paginado.
- `GET /documents/:id`: detalle y vista previa de hasta 2.000 caracteres.
- `GET /documents/:id/text`: texto extraído completo.
- `DELETE /documents/:id`: elimina metadatos y archivo.
- `POST /documents/:id/reprocess`: reintenta documentos `FAILED` u `OCR_REQUIRED`.

FastAPI expone `POST /extract` para uso interno de NestJS.

## Almacenamiento y persistencia local

`StorageService` ofrece `save`, `read`, `delete` y `exists`; su implementación local usa `UPLOAD_DIR`. Compose lo monta en `/data/uploads` mediante el volumen nombrado `turniting_uploads`. `docker compose down` conserva PostgreSQL y los documentos; `docker compose down -v` los elimina.

Las migraciones Prisma de F001 son incrementales y se aplican únicamente a PostgreSQL local. La migración inicial F000 no se modifica.

## QA local

La lista completa de comandos está en [LOCAL_SETUP.md](LOCAL_SETUP.md). La aceptación incluye lint, pruebas unitarias/e2e y build de backend; lint/build y smoke de navegador de frontend; Ruff y pytest de FastAPI; migración local; Docker y healthchecks; cargas PDF/DOCX/TXT/PDF escaneado/inválido; SHA-256; listado, detalle, texto, borrado y persistencia del volumen; y regresión de los endpoints F000 `/api/health`, `/api/health/db` y `/api/health/ai`.

No iniciar F002 automáticamente. Solo tras aprobar todas las pruebas, la siguiente fase es `F002_TURNITIN_REPORT_PARSER`.
