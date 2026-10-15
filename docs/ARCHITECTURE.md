# Arquitectura

## Flujo

```mermaid
flowchart TD
    U[Usuario] --> FE[React + Vite]
    FE -->|/api/documents| BE[NestJS]
    BE -->|Prisma| DB[(PostgreSQL local)]
    BE -->|StorageService| FS[(filesystem / Docker volume)]
    BE -->|multipart /extract| AI[FastAPI]
    AI -->|texto y métricas| BE
    AI -.->|Fases posteriores| OCR[OCR real / NLP / ML]
```

## Responsabilidades

### React + Vite

- Presenta el estado de los servicios y las rutas `/documents` y `/documents/:id`.
- Envía cargas y demás solicitudes únicamente a NestJS por medio de una capa HTTP centralizada.
- Usa una ruta relativa `/api` con el proxy de desarrollo o el reverse proxy local. En producción, `VITE_API_URL` se define al compilar el bundle.
- Valida extensión y tamaño en el cliente para orientar al usuario; NestJS repite las validaciones de seguridad.
- No conoce credenciales ni establece conexiones con PostgreSQL, Supabase, almacenamiento o FastAPI.

### NestJS

- Es la API principal y la única capa que accede a PostgreSQL.
- Valida extensión, MIME, firma del archivo y `MAX_UPLOAD_MB`; aplica CORS restringido, Helmet y `ValidationPipe` global.
- Guarda los binarios con nombres UUID mediante `StorageService`; la implementación local usa `UPLOAD_DIR` y no guarda binarios en PostgreSQL.
- Crea los metadatos/versiones y el texto extraído en PostgreSQL; los duplicados conservan documentos independientes con el mismo SHA-256.
- Expone carga, listado paginado, detalle, texto, borrado y reprocesamiento de documentos.
- Ejecuta comprobaciones reales de PostgreSQL y FastAPI en los endpoints de estado.
- Usa un cliente Prisma compartido. `AI_SERVICE_URL` identifica FastAPI y `AI_SERVICE_TIMEOUT_MS` limita la espera de extracción.

### FastAPI

- Provee `/health`, `POST /analyze/test` y `POST /extract` multipart.
- Extrae PDF con PyMuPDF, DOCX con python-docx y TXT con decodificación UTF-8/BOM y fallback; devuelve texto normalizado y métricas.
- Identifica PDF probablemente escaneados como `OCR_REQUIRED`; no ejecuta OCR.
- No accede a la base de datos ni estima si un texto fue generado por IA.
- Lee el puerto de escucha desde `PORT`.

### Almacenamiento local

- `UPLOAD_DIR` define el directorio de archivos en ejecución local.
- Docker Compose monta el volumen nombrado `turniting_uploads` en `/data/uploads`.
- `docker compose down` conserva los archivos; `docker compose down -v` elimina ese volumen.
- `StorageService` aísla las operaciones `save`, `read`, `delete` y `exists` para permitir una implementación de almacenamiento futura.

### PostgreSQL y Supabase

- PostgreSQL local corre como servicio Docker con volumen persistente y healthcheck `pg_isready`.
- F001 aplica migraciones incrementales solo a PostgreSQL local.
- `SUPABASE = DEFERRED_TO_F011`; no existe conexión remota de F001.

### Cloud Run

- `CLOUD_RUN = DEFERRED_TO_F011`; F001 no crea recursos GCP ni despliega imágenes.

## Datos de F001

Los modelos son `User`, `Document`, `DocumentVersion` y `Analysis`, con IDs UUID. Los archivos binarios permanecen en almacenamiento local. `DocumentVersion` conserva la clave de almacenamiento, SHA-256, texto extraído, conteos, página y advertencias. No se guardan segmentos, reportes de Turnitin, muestras de entrenamiento ni versiones de modelos.

## Referencias técnicas

- [Documentación de NestJS: configuración](https://docs.nestjs.com/techniques/configuration)
- [Prisma ORM v6: fuentes de datos y `directUrl`](https://www.prisma.io/docs/v6/orm/prisma-schema/overview/data-sources)
- [Supabase: conexión a PostgreSQL](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Google Cloud: autenticación servicio a servicio en Cloud Run](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
