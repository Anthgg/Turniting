# F006.2 · Research Analyzer UI

F006.2 agrega un flujo de análisis de investigación en la interfaz local. Se apoya en la extracción F001, OCR selectivo F003 y el servicio de párrafos F005. No incorpora otro modelo, no entrena ni promociona modelos, y no activa inferencia F006. El modelo activo permanece `NONE`.

Los documentos y las inferencias se procesan con los servicios de Docker locales. El resultado es una probabilidad calibrada expresada como señal estimada de participación de IA; no es un puntaje de Turnitin, no prueba autoría y no debe usarse por sí solo para tomar decisiones sobre una persona.

## Flujo de usuario

1. Abre el detalle de un documento y selecciona **Análisis de investigación**.
2. En la vista **Research · experimental**, el analizador inicial es `ENSEMBLE_V2_V3`, perfil `BALANCED`, párrafo estricto y agregación media ponderada por tokens. El perfil local fija `weighted_probability`, pesos 0.5/0.5 y umbral `0.59` para `BALANCED`.
3. La disponibilidad se lee del registro local de modelos. V2, V3 y su composición se pueden seleccionar solo si sus artefactos están disponibles. Las rutas del sistema de archivos no aparecen en la interfaz.
4. F006 se muestra como experimental y no disponible para inferencia. No es una opción del selector.
5. **Analizar IA** crea un nuevo `AnalysisRun`. Los análisis previos se conservan y aparecen en el historial con fecha, analizador, perfil, estado y señal global.
6. Los párrafos se pueden filtrar por nivel o texto insuficiente, ordenar por posición o señal, paginar y expandir bajo demanda. Los puntajes usan directamente `calibratedScore × 100`.
7. **Comparar versiones** usa los análisis completados compatibles y la alineación local existente. La comparación requiere el mismo analizador y perfil.

El mínimo de texto por párrafo, sus offsets y la clasificación `INSUFFICIENT_TEXT` siguen siendo responsabilidad del analizador F005 (`MIN_PARAGRAPH_CHARS=120`, `MIN_PARAGRAPH_WORDS=20`, `MIN_PARAGRAPH_TOKENS=32`). La UI no inventa una señal para texto insuficiente.

## API local

- `GET /api/models` informa modelos, estado de artefactos y la recomendación experimental. `activeModel` permanece `NONE`.
- `POST /api/documents/:id/analyze` ejecuta el analizador seleccionado sobre el texto extraído de la versión actual.
- `GET /api/documents/:id/analyses` lista el historial de la versión.
- `GET /api/analyses/:id/segments?page=1&pageSize=20&sort=PARAGRAPH&filter=ALL` pagina y filtra segmentos. Sin parámetros mantiene el contrato F005 y devuelve la lista completa.
- `POST /api/analyses/compare` reutiliza la alineación de versiones existente.

La caché reutiliza únicamente una ejecución completada con el mismo hash del texto, modelo y versión de preprocesamiento, perfil de umbral, modo de párrafo y versión del analizador. Una reutilización crea otro `AnalysisRun` y copia resultados; no sobrescribe el historial. Si cambian los componentes, el artefacto, el preprocesamiento, el texto o el perfil, se ejecuta inferencia. El cambio de perfil no reutiliza resultados crudos porque F005 no expone una etapa de recalibración desacoplada para esta ruta.

## Smoke local seguro

Requiere Docker Desktop y los artefactos locales V2/V3 ya instalados. Usa solo un DOCX sintético sin datos personales.

```powershell
docker compose up --build -d
docker compose ps
```

Abre <http://127.0.0.1:8080>, sube un DOCX sintético con varios párrafos largos en español y revisa:

- extracción completada; para un documento escaneado, OCR local antes de habilitar análisis;
- analizador `ENSEMBLE_V2_V3`, perfil `BALANCED`, y estado disponible de V2/V3;
- F006 mostrado como experimental no disponible y no seleccionable;
- resultado global, niveles por párrafo, texto insuficiente, filtro/orden/paginación e historial;
- una segunda ejecución conserva la primera en el historial;
- comparación de dos análisis compatibles si se creó una segunda versión;
- ausencia de errores en la consola del navegador.

Los formatos admitidos y el límite de carga (20 MiB) se validan en la API de documentos. Los PDFs escaneados y las imágenes continúan usando la clasificación y OCR selectivos F003. No se requiere migración de base de datos para F006.2.

Para pruebas automatizadas y rebuild sin caché, consulta el cierre de la rama. No ejecutes inferencia con documentos personales ni llames servicios externos desde este flujo.
