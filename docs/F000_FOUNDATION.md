# F000 — Foundation fullstack

Estado general: `FAIL_WITH_FINDINGS`. La base local y Docker pasan; Supabase y Cloud Run requieren datos de destino y configuración externa.

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

QA local y Docker ejecutado el 2026-10-15. El cierre completo de F000 queda pendiente de configurar Supabase y desplegar/verificar Cloud Run.

| Área | Comando/evidencia | Resultado |
|---|---|---|
| Backend | `npm ci`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run build`, `npm audit` | PASS: 16 pruebas unitarias, 5 pruebas e2e, build y lint; audit reportó 0 vulnerabilidades. Health HTTP 200. |
| Frontend | `npm run lint`, `npm run build`; navegador real en `http://localhost:8080` | PASS: lint/build; UI muestra API, PostgreSQL e IA como operativos. |
| FastAPI | entorno virtual limpio; `ruff check .`, `pytest -q`, rutas `/health` y `/analyze/test` | PASS: Ruff; 6 tests; health y análisis HTTP 200. Prueba de texto: 26 caracteres y 6 palabras. |
| PostgreSQL local | servicio Compose `db`, migración Prisma de arranque y `/api/health/db` | PASS: PostgreSQL 16 healthy, migración aplicada y `SELECT 1` confirmado por health HTTP 200. |
| Docker Compose | `docker compose config --quiet`, `docker compose build --no-cache`, `docker compose up -d`, `docker compose ps` | PASS: `db`, `backend`, `ai-service` y `frontend` healthy. GET de salud y POST de análisis HTTP 200 también a través del proxy Nginx. El backend responde CORS al origen local permitido y no concede cabecera CORS a un origen no listado. |
| Supabase | `supabase_list_projects`, organización Anthony elegida | BLOQUEADO: no hay proyecto Turniting. El conector no expuso la herramienta obligatoria de consulta de costo; no se solicitó confirmación ni se creó un proyecto. Conexión, migración y smoke no ejecutados. |
| Cloud Run | `gcloud auth list`, `gcloud projects list`, configuración activa | BLOQUEADO: se eligió crear un proyecto dedicado, pero falta definir ID, región y cuenta de facturación. El proyecto activo pertenece a Cotizador Greda y no se utilizó. No se creó proyecto ni se desplegó. |

## Docker

`docker-compose.yml` define los cuatro servicios locales. PostgreSQL conserva datos en `turniting_pgdata`; `docker compose down` no elimina el volumen. Para levantar desde cero, usa [LOCAL_SETUP.md](LOCAL_SETUP.md) y valida que `docker compose ps` muestre los healthchecks como `healthy`.

## Supabase

La guía está en [SUPABASE_SETUP.md](SUPABASE_SETUP.md). La aplicación accede a PostgreSQL exclusivamente desde NestJS/Prisma. `DATABASE_URL` y `DIRECT_URL` se obtienen de la configuración real del proyecto. No guardar URLs ni contraseñas en este documento.

## Cloud Run

La guía está en [CLOUD_RUN_DEPLOYMENT.md](CLOUD_RUN_DEPLOYMENT.md). FastAPI debe permanecer privado y aceptar invocaciones de la identidad backend mediante ID token. El frontend y backend son públicos con límites de recursos y CORS restringidos.

## Git

`feat/f000-foundation` está publicada en `https://github.com/Anthgg/Turniting.git` con los commits de implementación y cierre documental. No se creó PR ni se hizo merge a `main`.

## Problemas encontrados y soluciones

- `npm ci` falló inicialmente con `Missing: magicast@0.3.5 from lock file` bajo Node 22/npm 10. Se regeneró `package-lock.json` y se comprobó `npm ci` en la misma familia de Node 22/npm 10.
- `npm audit` encontró avisos altos en dependencias transitivas de Prisma y en el paquete de desarrollo no usado `@nestjs/mau`. Se actualizaron `deepmerge-ts` a 8.0.2 y `effect` a 3.20.0 mediante overrides, se retiró `@nestjs/mau` y se repitieron pruebas/build. El audit completo final reportó cero vulnerabilidades.
- La plantilla especifica `CORS_ORIGIN`; el backend y Compose quedaron alineados a ese nombre. Su valor puede incluir varios orígenes separados por comas, sin comodines.
- La plantilla raíz inicial pasaba URLs `localhost` del host al contenedor y tenía una contraseña fija de desarrollo. Compose ahora construye URLs internas hacia `db`, exige `POSTGRES_PASSWORD` en `.env` y la plantilla pide un valor local aleatorio. La configuración se validó sin mostrar la contraseña.
- El primer smoke encontró que Nginx escuchaba en 8080 dentro del contenedor, mientras Compose publicaba el puerto 80. Se cambió Nginx y su healthcheck al puerto 80; el proxy web y las rutas API pasaron en el smoke final.
- No se creó un proyecto Supabase Turniting. Se eligió la organización Anthony; el conector no permitió consultar el costo, así que no se pudo presentar para confirmación antes de crear el proyecto.
- Se eligió el proyecto GCP dedicado `turniting-f000-20261015` en `southamerica-west1`. El usuario indicó que la facturación existente ya está configurada y se observó una cuenta activa en la consola. No se creó ni vinculó el proyecto Turniting porque asociar facturación requiere confirmar que esa cuenta debe asumir los cargos. `cotizador-greda` no se modificó.

## Pendientes

- Restablecer la consulta de costo de Supabase, presentar el importe para confirmación y crear el proyecto Turniting en la organización Anthony; después configurar las URLs reales solo en backend, aplicar `migrate deploy`, comprobar `SELECT 1` y realizar smoke.
- Confirmar que la cuenta activa identificada en la consola es la que debe pagar Turniting; después crear el proyecto GCP dedicado autorizado, vincular esa cuenta, preparar Artifact Registry, desplegar los tres servicios, aplicar mínimos permisos de invocación y completar QA de producción, sin cambiar Cotizador Greda.
- No comenzar F001 hasta que F000 esté cerrada por separado.

## Commit final

El hash final de Git se registra en el reporte de cierre. Este documento forma parte del commit de documentación de F000.
