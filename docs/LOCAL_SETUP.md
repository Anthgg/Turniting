# Preparación local

## Clonar el repositorio

La base local F000 está publicada en `feat/f000-foundation`. F001 se desarrolla en `feat/f001-document-ingestion`:

```powershell
git clone --branch feat/f000-foundation https://github.com/Anthgg/Turniting.git
Set-Location Turniting
```

## Opción recomendada: Docker Compose

Requisitos: Docker Desktop iniciado y Docker Compose v2.

Desde la raíz del repositorio, en PowerShell:

```powershell
Copy-Item .env.example .env
# Edita .env y reemplaza POSTGRES_PASSWORD por un valor aleatorio alfanumérico.
docker compose config
docker compose up --build -d
docker compose ps
```

Cuando los cuatro servicios indiquen `healthy`, comprobar:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/health/db
Invoke-RestMethod http://localhost:3000/api/health/ai
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod -Method Post -Uri http://localhost:8000/analyze/test -ContentType 'application/json' -Body '{"text":"Este es un texto de prueba"}'
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/ai/analyze/test -ContentType 'application/json' -Body '{"text":"Este es un texto de prueba"}'
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/ai/analyze/test -ContentType 'application/json' -Body '{"text":"Este es un texto de prueba"}'
```

Abre <http://localhost:8080> para la interfaz. En Docker, Nginx sirve el bundle y reenvía `/api/` a NestJS. PostgreSQL se conserva en `turniting_pgdata`; los documentos se conservan en `turniting_uploads`, montado en `/data/uploads`.

```powershell
docker compose down
```

Este comando detiene la pila sin eliminar datos. Para borrar la base y archivos locales de Compose de forma intencional, primero comprueba los volúmenes y después usa `docker compose down -v`.

## Ejecución individual

### Backend

Requisitos: Node.js LTS y npm.

```powershell
Set-Location backend
npm ci
npm run lint
npm run test
npm run test:e2e
npm run build
```

Configura `DATABASE_URL`, `DIRECT_URL`, `AI_SERVICE_URL`, `AI_SERVICE_TIMEOUT_MS`, `MAX_UPLOAD_MB`, `UPLOAD_DIR`, `CORS_ORIGIN`, `NODE_ENV` y `PORT` mediante `backend/.env.example`. Para ejecutar endpoints de salud y documentos, inicia PostgreSQL y FastAPI y aplica las migraciones Prisma.

### Frontend

```powershell
Set-Location frontend
npm ci
npm run lint
npm run build
npm run dev
```

El servidor Vite usa el proxy `/api` hacia `http://localhost:3000`; ajusta `VITE_API_URL` y `VITE_MAX_UPLOAD_MB` en `frontend/.env.example`.

### Servicio IA y OCR local

Requisitos para el runtime PaddleOCR: Python 3.12, compatible con las ruedas fijadas de NumPy 1.26.4, OpenCV y PaddlePaddle. Docker Compose usa la misma versión.

```powershell
Set-Location ai-service
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
python -m pip install --no-deps paddleocr==3.7.0 paddlex==3.7.0
$env:OCR_MODEL_DIR = Join-Path (Get-Location) '.ocr-model-cache'
python -m scripts.warmup_ocr
ruff check .
pytest
uvicorn app.main:app --reload --port 8000
```

El primer calentamiento descarga los modelos `PP-OCRv5_mobile_det` y `latin_PP-OCRv5_mobile_rec` al directorio local; las ejecuciones siguientes los reutilizan. En Compose, los modelos persisten en `turniting_ai_models`. Para generar fixtures sin datos privados y medir CER/WER, ejecuta desde la raíz:

```powershell
docker compose up --build -d
docker compose exec ai-service python -m scripts.warmup_ocr
docker compose restart ai-service
docker compose exec ai-service python -m scripts.create_synthetic_ocr_fixtures /tmp/f003-synthetic
docker compose exec ai-service python -m scripts.evaluate_synthetic_ocr /tmp/f003-synthetic
```

## Variables

`.env.example` en la raíz documenta el conjunto local de Compose. `MAX_UPLOAD_MB` limita la carga y por defecto es 20 MB; `UPLOAD_DIR` define la ruta persistente (`/data/uploads` en Compose). `OCR_*` controla el clasificador, límites de render, timeout y modelo local; `AI_OCR_TIMEOUT_MS` limita la espera del backend. `OCR_MAX_PAGES_PER_RUN` limita cada ejecución a 150 páginas y `OCR_MAX_RENDER_PIXELS` impone un presupuesto por página. Los archivos `.env.example` de cada servicio explican las variables requeridas por ejecución individual. Los valores de ejemplo solo sirven para desarrollo local; crea variables de producción por separado y no subas archivos `.env`.

## Verificación F001

Desde cada carpeta de servicio, instala dependencias congeladas y ejecuta:

```powershell
# backend
npm ci
npm run lint
npm run test
npm run test:e2e
npm run build

# frontend
npm ci
npm run lint
npm run build

# ai-service
python -m pip install -r requirements-dev.txt
ruff check .
pytest
```

Después ejecuta el smoke test de carga desde `http://localhost:8080/documents` con PDF, DOCX, TXT, PDF escaneado y un archivo inválido. Consulta el procedimiento y las rutas en [docs/F001_DOCUMENT_INGESTION.md](F001_DOCUMENT_INGESTION.md).

## Datasets F004

Compose monta `./training` en el backend como solo lectura (`TRAINING_DIR=/app/training`). En ejecución individual, `backend/.env` usa `TRAINING_DIR=../training`. Para registrar el dataset y los modelos ya entrenados (sin entrenar ni descargar nada):

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/api/datasets/register -ContentType 'application/json' -Body '{"name":"TURNITING_DATASET","version":"V1","manifestPath":"datasets/manifests","statisticsPath":"reports/dataset_statistics.json"}'
Invoke-RestMethod -Method Post http://127.0.0.1:3000/api/model-versions/import-registry -ContentType 'application/json' -Body '{"datasetVersionId":"<id>"}'
```

Abre `http://localhost:8080/datasets`. Los datos crudos, Parquet, modelos y checkpoints de `training/` están en `.gitignore` y no entran en ninguna imagen Docker. Ver [F004_DATASET.md](F004_DATASET.md).

## Puertos

| Dirección | Servicio |
|---|---|
| `http://localhost:8080` | Frontend Nginx |
| `http://localhost:3000/api` | NestJS |
| `http://localhost:8000` | FastAPI |
| `localhost:5432` | PostgreSQL local |
