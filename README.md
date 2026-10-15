# Turniting

Turniting es una aplicación local para ingesta y extracción de texto de documentos académicos. F000 cerró la base local; F001 implementa carga de PDF, DOCX y TXT, almacenamiento local persistente y extracción de texto. La detección de escritura generada por IA y el análisis de similitud siguen fuera de alcance.

> Turniting es una herramienta independiente de análisis probabilístico. No constituye un resultado oficial de Turnitin ni afirma reproducir su algoritmo propietario.

## Arquitectura

```mermaid
flowchart TD
    U[Usuario] --> FE[React + Vite]
    FE -->|HTTP /api| BE[NestJS]
    BE -->|Prisma| DB[(PostgreSQL local)]
    BE -->|StorageService| FS[(Docker volume / local filesystem)]
    BE -->|multipart /extract| AI[FastAPI]
    AI -->|text and extraction metadata| BE
    AI -.-> FUT[OCR real / NLP / ML futuro]
```

React consume exclusivamente la API NestJS. NestJS valida, conserva el archivo y persiste metadatos/texto en PostgreSQL. FastAPI extrae texto y no se conecta a PostgreSQL. Los archivos se guardan en el volumen local `turniting_uploads`.

## Stack

| Servicio | Tecnología | Puerto local |
|---|---|---:|
| Frontend | React, Vite, TypeScript | 8080 con Docker; 5173 en desarrollo |
| Backend | NestJS, TypeScript, Prisma | 3000 |
| Servicio IA | Python, FastAPI | 8000 |
| Base de datos | PostgreSQL | 5432 |

## Estructura

```text
backend/       API principal, Prisma y migraciones
frontend/      aplicación React y Nginx
ai-service/    API FastAPI ligera
docs/          arquitectura, instalación y despliegue
docker-compose.yml
```

## Requisitos

- Docker Desktop con Docker Compose v2 para ejecutar la pila local.
- Node.js y npm para los comandos de desarrollo y QA del backend/frontend.
- Python 3.12 o superior para ejecutar el servicio IA fuera de Docker.

## Inicio local con Docker

```powershell
Copy-Item .env.example .env
# Edit .env and replace POSTGRES_PASSWORD with a random alphanumeric value.
docker compose config
docker compose up --build -d
docker compose ps
```

Direcciones locales:

- Frontend: <http://localhost:8080>
- Backend: <http://localhost:3000/api/health>
- Base de datos: <http://localhost:3000/api/health/db>
- Integración con IA: <http://localhost:3000/api/health/ai>
- FastAPI: <http://localhost:8000/health>

Para detener los contenedores sin borrar la base de datos:

```powershell
docker compose down
```

El volumen local persiste entre reinicios. `docker compose down -v` lo elimina y debe usarse solo cuando se desee borrar esa base local.

## Variables de entorno

La plantilla raíz `.env.example` reúne valores locales para PostgreSQL de Docker Compose y para NestJS ejecutado desde el host; Compose deriva las URLs internas de los contenedores. Copia esa plantilla a `.env` y reemplaza `POSTGRES_PASSWORD` por un valor aleatorio antes de iniciar los servicios. `CORS_ORIGIN` acepta varios orígenes explícitos separados por comas; no admite comodines.

Para ejecutar servicios individualmente, consulta `backend/.env.example`, `frontend/.env.example` y `ai-service/.env.example`. Los valores de ejemplo son locales. Mantén URLs de base de datos, contraseñas y tokens fuera del frontend, del repositorio y de las imágenes Docker.

## Comandos frecuentes

```powershell
docker compose config --quiet
docker compose up --build -d
docker compose ps
docker compose logs -f backend ai-service db frontend
docker compose down
```

`docker compose down` conserva los volúmenes `turniting_pgdata` y `turniting_uploads`. No uses `docker compose down -v` salvo que quieras borrar la base y los documentos locales.

## Solución de problemas

- Si Compose indica que falta `POSTGRES_PASSWORD`, crea `.env` desde `.env.example` y establece un valor aleatorio local.
- Si un servicio no llega a `healthy`, revisa `docker compose ps` y `docker compose logs <servicio>` antes de reiniciarlo.
- Si un puerto local ya está ocupado, detén el proceso que lo usa o cambia el puerto publicado correspondiente en `docker-compose.yml`.
- Si falla la conexión a PostgreSQL después de cambiar la contraseña local, conserva la contraseña que inicializó el volumen o rota el rol de forma intencional. Borrar el volumen también borra los datos locales.

## Desarrollo y pruebas

Los comandos de cada paquete y la preparación local están en [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md). La configuración no contiene credenciales reales; `.env.example` usa valores exclusivamente locales.

## Supabase y Cloud Run

SUPABASE = DEFERRED_TO_F011. F001 no crea proyectos ni conexiones Supabase; sus migraciones se ejecutan solo contra PostgreSQL local. La guía existente [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) queda como referencia para F011.

CLOUD_RUN = DEFERRED_TO_F011. F001 no crea proyectos GCP ni despliega servicios. [docs/CLOUD_RUN_DEPLOYMENT.md](docs/CLOUD_RUN_DEPLOYMENT.md) queda como referencia futura.

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md)
- [Ingesta de documentos F001](docs/F001_DOCUMENT_INGESTION.md)
- [Instalación local](docs/LOCAL_SETUP.md)
- [Configuración de Supabase](docs/SUPABASE_SETUP.md)
- [Despliegue en Cloud Run](docs/CLOUD_RUN_DEPLOYMENT.md)
- [Cierre F000](docs/F000_FOUNDATION.md)
