# Preparación local

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
```

Abre <http://localhost:8080> para la interfaz. En Docker, Nginx sirve el bundle y reenvía `/api/` a NestJS. La base local se conserva en el volumen `turniting_pgdata`.

```powershell
docker compose down
```

Este comando detiene la pila sin eliminar datos. Para borrar la base local de Compose de forma intencional, primero comprueba el nombre y el contenido del volumen y después usa `docker compose down -v`.

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

Configura `DATABASE_URL`, `DIRECT_URL`, `AI_SERVICE_URL`, `CORS_ORIGINS`, `NODE_ENV` y `PORT` mediante `backend/.env.example`. Para ejecutar endpoints de salud de base de datos e IA, inicia PostgreSQL y FastAPI y aplica las migraciones Prisma.

### Frontend

```powershell
Set-Location frontend
npm ci
npm run lint
npm run build
npm run dev
```

El servidor Vite usa el proxy `/api` hacia `http://localhost:3000`; la configuración puede ajustarse en `frontend/.env.example`.

### Servicio IA

Requisitos: Python 3.12 o superior.

```powershell
Set-Location ai-service
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
ruff check .
pytest
uvicorn app.main:app --reload --port 8000
```

## Variables

`.env.example` en la raíz documenta el conjunto local de Compose. Los archivos `.env.example` de cada servicio explican las variables requeridas por ejecución individual. Los valores de ejemplo solo sirven para desarrollo local; crea variables de producción por separado y no subas archivos `.env`.

## Puertos

| Dirección | Servicio |
|---|---|
| `http://localhost:8080` | Frontend Nginx |
| `http://localhost:3000/api` | NestJS |
| `http://localhost:8000` | FastAPI |
| `localhost:5432` | PostgreSQL local |
