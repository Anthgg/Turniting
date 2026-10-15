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

## Validación posterior

Registra las URLs reales y valida HTTP 200 para el frontend, `GET /api/health`, `GET /api/health/db`, `GET /api/health/ai` y `GET /health` desde un contexto autorizado. Comprueba que:

- NestJS conecta a Supabase por TLS.
- NestJS invoca FastAPI usando identidad de servicio.
- El frontend consume el backend sin CORS erróneo ni URL `localhost`.
- FastAPI no es invocable anónimamente.
- Ningún secreto aparece en bundle, imagen, configuración pública o logs.

## Referencia

- [Google Cloud: autenticación servicio a servicio en Cloud Run](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
