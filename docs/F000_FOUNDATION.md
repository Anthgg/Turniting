# F000 — Foundation fullstack

Estado general: `PASS` — alcance `LOCAL_FOUNDATION`. Supabase y Cloud Run quedan `DEFERRED_TO_F011` por instrucción del usuario.

## Objetivo y alcance

Preparar el monorepo para una aplicación web de análisis académico con tres servicios: React/Vite, NestJS/Prisma y FastAPI. F000 incluye salud de backend, PostgreSQL y servicio IA, modelos iniciales mínimos, ejecución reproducible con Docker Compose y guías de operación.

F000 no implementa carga o extracción de documentos, OCR, detección real de escritura generada por IA, modelos ML, parser de reportes Turnitin ni calibración. El producto es independiente y no afirma replicar Turnitin.

## Arquitectura

```text
Usuario → React → NestJS → PostgreSQL local / Supabase
                         └→ FastAPI → OCR/NLP/ML futuro
```

React solo consume NestJS. NestJS es responsable de acceso a datos y orquestación. FastAPI no accede a la base.

## Servicios

- `frontend/`: React, Vite, TypeScript y Nginx para producción.
- `backend/`: NestJS, configuración validada, Prisma, endpoints `/api/health`, `/api/health/db` y `/api/health/ai`.
- `ai-service/`: FastAPI con `GET /health` y `POST /analyze/test`.
- `db`: PostgreSQL local con volumen persistente y `pg_isready`.

## Variables

La raíz y los servicios incluyen plantillas `.env.example`. Los valores del repositorio son ilustrativos y locales. Producción utiliza secretos fuera de Git. Las variables principales son `DATABASE_URL`, `DIRECT_URL`, `AI_SERVICE_URL`, `AI_SERVICE_AUTH_MODE`, `CORS_ORIGIN` (lista de orígenes separados por comas), `VITE_API_URL`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `PYTHON_ENV` y `PORT`.

## Pruebas y resultados

QA local y Docker ejecutado el 2026-10-15. F000 se cierra como base local; la configuración de Supabase y Cloud Run pertenece a F011.

| Área | Comando/evidencia | Resultado |
|---|---|---|
| Backend | `npm ci`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run build`, `npm audit` | PASS: 16 pruebas unitarias, 5 pruebas e2e, build y lint; audit reportó 0 vulnerabilidades. Health HTTP 200. |
| Frontend | `npm run lint`, `npm run build`; navegador real en `http://localhost:8080` | PASS: lint/build; UI muestra API, PostgreSQL e IA como operativos. |
| FastAPI | entorno virtual limpio; `ruff check .`, `pytest -q`, rutas `/health` y `/analyze/test` | PASS: Ruff; 6 tests; health y análisis HTTP 200. Prueba de texto: 26 caracteres y 6 palabras. |
| PostgreSQL local | servicio Compose `db`, migración Prisma de arranque y `/api/health/db` | PASS: PostgreSQL 16 healthy, migración aplicada y `SELECT 1` confirmado por health HTTP 200. |
| Docker Compose | `docker compose config --quiet`, `docker compose build --no-cache`, `docker compose up -d`, `docker compose ps` | PASS: `db`, `backend`, `ai-service` y `frontend` healthy. GET de salud y POST de análisis HTTP 200 también a través del proxy Nginx. El backend responde CORS al origen local permitido y no concede cabecera CORS a un origen no listado. |
| Supabase | Organización Anthony elegida | DEFERRED_TO_F011: no se creó ni configuró proyecto; conexión, migración y smoke quedan para F011. |
| Cloud Run | Destino propuesto: `turniting-f000-20261015`, `southamerica-west1` | DEFERRED_TO_F011: no se creó proyecto, no se vinculó facturación ni se desplegó. `cotizador-greda` no se utilizó ni modificó. |

## Docker

`docker-compose.yml` define los cuatro servicios locales. PostgreSQL conserva datos en `turniting_pgdata`; `docker compose down` no elimina el volumen. Para levantar desde cero, usa [LOCAL_SETUP.md](LOCAL_SETUP.md) y valida que `docker compose ps` muestre los healthchecks como `healthy`.

## Supabase

La guía está en [SUPABASE_SETUP.md](SUPABASE_SETUP.md). La aplicación accede a PostgreSQL exclusivamente desde NestJS/Prisma. `DATABASE_URL` y `DIRECT_URL` se obtienen de la configuración real del proyecto. No guardar URLs ni contraseñas en este documento.

## Cloud Run

La guía está en [CLOUD_RUN_DEPLOYMENT.md](CLOUD_RUN_DEPLOYMENT.md). FastAPI debe permanecer privado y aceptar invocaciones de la identidad backend mediante ID token. El frontend y backend son públicos con límites de recursos y CORS restringidos.

## Git

`feat/f000-foundation` está publicada en `https://github.com/Anthgg/Turniting.git` con los commits de implementación y cierre documental. No se creó PR ni se hizo merge a `main`.

No se integró F000 en `main`: no existe una rama `main` local ni remota; `git ls-remote --heads origin` mostró únicamente `feat/f000-foundation`. F001 continuará desde este commit validado, sin crear ni modificar una rama principal.

## Problemas encontrados y soluciones

- `npm ci` falló inicialmente con `Missing: magicast@0.3.5 from lock file` bajo Node 22/npm 10. Se regeneró `package-lock.json` y se comprobó `npm ci` en la misma familia de Node 22/npm 10.
- `npm audit` encontró avisos altos en dependencias transitivas de Prisma y en el paquete de desarrollo no usado `@nestjs/mau`. Se actualizaron `deepmerge-ts` a 8.0.2 y `effect` a 3.20.0 mediante overrides, se retiró `@nestjs/mau` y se repitieron pruebas/build. El audit completo final reportó cero vulnerabilidades.
- La plantilla especifica `CORS_ORIGIN`; el backend y Compose quedaron alineados a ese nombre. Su valor puede incluir varios orígenes separados por comas, sin comodines.
- La plantilla raíz inicial pasaba URLs `localhost` del host al contenedor y tenía una contraseña fija de desarrollo. Compose ahora construye URLs internas hacia `db`, exige `POSTGRES_PASSWORD` en `.env` y la plantilla pide un valor local aleatorio. La configuración se validó sin mostrar la contraseña.
- El primer smoke encontró que Nginx escuchaba en 8080 dentro del contenedor, mientras Compose publicaba el puerto 80. Se cambió Nginx y su healthcheck al puerto 80; el proxy web y las rutas API pasaron en el smoke final.
- Supabase y Cloud Run quedaron diferidos a F011 por instrucción del usuario. No se crearon recursos remotos ni se cambió `cotizador-greda`.

## Pendientes

- Supabase: en F011, aprovisionar el proyecto en la organización Anthony; configurar las URLs reales solo en backend, aplicar `migrate deploy`, comprobar `SELECT 1` y realizar smoke.
- Cloud Run: en F011, aprovisionar el proyecto dedicado y completar Artifact Registry, despliegues, permisos mínimos de invocación y QA de producción, sin modificar `cotizador-greda`.
- La siguiente fase local es F001 — Document Ingestion.

## Commit final

El hash final de Git se registra en el reporte de cierre. Este documento forma parte del commit de documentación de F000.
