# Despliegue en Google Cloud Run

Esta guía describe el despliegue previsto de F000. Ejecuta los pasos solo después de que la validación local, Docker y Supabase hayan pasado. No se incluyen valores de proyecto, región ni servicios que no hayan sido verificados.

## Componentes y exposición

| Servicio | Exposición | Configuración |
|---|---|---|
| `turniting-front` | Público | Nginx + bundle React; `min=0`, `max=3` |
| `turniting-back` | Público | NestJS; CORS solo para el frontend y orígenes locales requeridos; `min=0`, `max=3` |
| `turniting-ai` | Privado | FastAPI; recibe solicitudes autenticadas de NestJS; `min=0`, `max=3` |

Cada servicio usa su propio Dockerfile. `PORT` debe ser el puerto inyectado por Cloud Run. El frontend usa `VITE_API_URL` en build time, porque Vite incorpora ese valor al bundle; construye el frontend después de conocer la URL backend o implementa y verifica una configuración de runtime.

## Prerrequisitos

- Un proyecto GCP de Turniting y una región de Cloud Run elegida según la disponibilidad vigente.
- Cloud Billing ya habilitado por una persona autorizada.
- Artifact Registry, Cloud Run y Secret Manager habilitados según las políticas de la organización.
- Una cuenta de servicio dedicada para el backend y otra para el servicio IA cuando las políticas lo requieran.
- `DATABASE_URL` y `DIRECT_URL` en Secret Manager.

No reutilices silenciosamente un proyecto GCP de otra aplicación. No crees proyecto, cambies facturación ni otorgues roles amplios como `Owner` para completar esta guía.

## Identidad servicio a servicio

1. Despliega `turniting-ai` sin permitir invocación no autenticada.
2. Asigna al backend una identidad de servicio dedicada.
3. Otorga a esa identidad solamente `roles/run.invoker` sobre el servicio IA.
4. Configura el backend con `AI_SERVICE_AUTH_MODE=google-id-token` y `AI_SERVICE_URL` igual a la URL Cloud Run del servicio IA.
5. El backend debe emitir un ID token de corta duración cuya audiencia sea la URL del servicio receptor. No guardes tokens en variables ni archivos.
6. Comprueba `GET /api/health/ai` desde el backend desplegado y verifica que una invocación no autenticada al servicio IA sea rechazada.

## Construcción y despliegue

Registra las imágenes en Artifact Registry con una etiqueta inmutable basada en el SHA del commit. Usa `latest` solo como alias adicional. Construye y publica por separado:

```text
backend/Dockerfile
frontend/Dockerfile   (VITE_API_URL=https://<BACKEND_URL>/api al construir)
ai-service/Dockerfile
```

Despliega primero el servicio IA privado, luego el backend con su identidad, URL del servicio IA y secretos desde Secret Manager. Despliega el frontend con el `VITE_API_URL` backend exacto. Configura recursos modestos, sin GPU, `min instances=0` y `max instances=3`.

El backend es público para recibir tráfico del frontend, pero su política CORS debe limitar el navegador al origen exacto del frontend. Cloud Run público no reemplaza autenticación de usuario; la autenticación funcional queda fuera de F000.

### Procedimiento reproducible con PowerShell

Sustituye los marcadores por el ID de proyecto y la región aprobados. No ejecutes estos pasos sobre un proyecto de otra aplicación. El ejemplo etiqueta cada imagen con el SHA completo del commit y usa límites de cero a tres instancias.

```powershell
$ErrorActionPreference = 'Stop'
$ProjectId = '<PROJECT_ID>'
$Region = '<REGION>'
$Repository = 'turniting'
$CommitSha = (git rev-parse HEAD).Trim()
$Registry = "$Region-docker.pkg.dev/$ProjectId/$Repository"
$BackendSa = "turniting-back@$ProjectId.iam.gserviceaccount.com"
$AiSa = "turniting-ai@$ProjectId.iam.gserviceaccount.com"

gcloud services enable run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com --project $ProjectId
gcloud artifacts repositories create $Repository --repository-format=docker --location $Region --project $ProjectId
gcloud auth configure-docker "$Region-docker.pkg.dev" --quiet

gcloud iam service-accounts create turniting-back --project $ProjectId
gcloud iam service-accounts create turniting-ai --project $ProjectId

$AiImage = "$Registry/turniting-ai:$CommitSha"
$BackendImage = "$Registry/turniting-back:$CommitSha"
docker build -f .\ai-service\Dockerfile -t $AiImage .\ai-service
docker build -f .\backend\Dockerfile -t $BackendImage .\backend
docker push $AiImage
docker push $BackendImage

gcloud run deploy turniting-ai --project $ProjectId --region $Region --image $AiImage --port 8000 --cpu 1 --memory 512Mi --min 0 --max 3 --service-account $AiSa --no-allow-unauthenticated
$AiUrl = (gcloud run services describe turniting-ai --project $ProjectId --region $Region --format='value(status.url)').Trim()
gcloud run services add-iam-policy-binding turniting-ai --project $ProjectId --region $Region --member="serviceAccount:$BackendSa" --role=roles/run.invoker

# Create these Secret Manager secrets with the verified Supabase URLs before deployment.
# Grant turniting-back access only to these two secrets with roles/secretmanager.secretAccessor.
$BackendSecretBindings = @('turniting-database-url', 'turniting-direct-url')
foreach ($Secret in $BackendSecretBindings) {
  gcloud secrets add-iam-policy-binding $Secret --project $ProjectId --member="serviceAccount:$BackendSa" --role=roles/secretmanager.secretAccessor
}

# Apply production migrations before serving requests. The commands do not print secret values.
$env:DATABASE_URL = (gcloud secrets versions access latest --secret=turniting-database-url --project $ProjectId).Trim()
$env:DIRECT_URL = (gcloud secrets versions access latest --secret=turniting-direct-url --project $ProjectId).Trim()
try {
  Push-Location backend
  npm run prisma:migrate:deploy
  if ($LASTEXITCODE -ne 0) { throw 'Prisma migrate deploy failed; stop before Cloud Run deploy.' }
} finally {
  Pop-Location
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DIRECT_URL -ErrorAction SilentlyContinue
}

# This first CORS value is temporary. Replace it with the frontend URL after its deployment.
gcloud run deploy turniting-back --project $ProjectId --region $Region --image $BackendImage --port 3000 --cpu 1 --memory 512Mi --min 0 --max 3 --allow-unauthenticated --service-account $BackendSa --set-env-vars="NODE_ENV=production,AI_SERVICE_URL=$AiUrl,AI_SERVICE_AUTH_MODE=google-id-token,CORS_ORIGIN=http://localhost:5173" --set-secrets="DATABASE_URL=turniting-database-url:latest,DIRECT_URL=turniting-direct-url:latest"
$BackendUrl = (gcloud run services describe turniting-back --project $ProjectId --region $Region --format='value(status.url)').Trim()

$FrontendImage = "$Registry/turniting-front:$CommitSha"
docker build -f .\frontend\Dockerfile --build-arg "VITE_API_URL=$BackendUrl/api" -t $FrontendImage .\frontend
docker push $FrontendImage
gcloud run deploy turniting-front --project $ProjectId --region $Region --image $FrontendImage --port 80 --cpu 1 --memory 512Mi --min 0 --max 3 --allow-unauthenticated
$FrontendUrl = (gcloud run services describe turniting-front --project $ProjectId --region $Region --format='value(status.url)').Trim()

# Production accepts the exact frontend origin. Local origins stay in local development config.
gcloud run services update turniting-back --project $ProjectId --region $Region --update-env-vars="CORS_ORIGIN=$FrontendUrl"
```

El deployer necesita permisos para publicar imágenes y desplegar servicios, además de `roles/iam.serviceAccountUser` sobre las identidades de runtime. El backend solo recibe acceso a los dos secretos de base de datos y `roles/run.invoker` sobre `turniting-ai`. FastAPI no necesita permisos de base de datos.

## Validación posterior

Registra las URLs reales y valida HTTP 200 para el frontend, `GET /api/health`, `GET /api/health/db`, `GET /api/health/ai` y `GET /health` desde un contexto autorizado. Comprueba que:

- NestJS conecta a Supabase por TLS.
- NestJS invoca FastAPI usando identidad de servicio.
- El frontend consume el backend sin CORS erróneo ni URL `localhost`.
- FastAPI no es invocable anónimamente.
- Ningún secreto aparece en bundle, imagen, configuración pública o logs.

## Referencia

- [Google Cloud: autenticación servicio a servicio en Cloud Run](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
- [Google Cloud: regiones disponibles de Cloud Run](https://docs.cloud.google.com/run/docs/locations)
- [Google Cloud: desplegar imágenes de contenedor en Cloud Run](https://docs.cloud.google.com/run/docs/deploying)
- [Google Cloud: configurar secretos para servicios Cloud Run](https://docs.cloud.google.com/run/docs/configuring/services/secrets)
