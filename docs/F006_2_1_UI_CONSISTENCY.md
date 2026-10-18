# F006.2.1 — Consistencia de UI, determinismo y referencia externa

## Alcance

Esta fase corrige la presentación y la trazabilidad de F006.2. No cambia pesos,
umbrales, calibración, reglas de agregación del modelo ni entrenamiento. No añade
migraciones y no activa F006 ni F007. Las verificaciones usan fixtures sintéticos;
no se abrió ningún documento privado.

## Resultado de una ejecución

- El puntaje global presentado proviene de `AnalysisRun.documentScore`. El backend
  devuelve además `documentScorePercent`, redondeado con `Math.round(score * 100)`.
  Historial, resultado, párrafos y comparación aplican la misma regla.
- El resumen del run seleccionado muestra ID corto, fecha, analizador, perfil,
  modo de párrafo, agregación, umbral, puntaje, duración de inferencia y `cacheHit`.
  La configuración se toma del run guardado y no de los controles de la siguiente
  ejecución.
- La respuesta de segmentos incluye `analysisId`; la UI no renderiza segmentos
  cuyo ID no coincida con el run seleccionado.
- Errores de análisis, segmentos, historial, comparación, estado de modelos y
  carga se presentan por operación. Un error secundario conserva visible el puntaje
  persistido del run completado.
- Cambiar de documento o de flujo vuelve a inicializar los controles. El modo
  inicial es `STRICT_PARAGRAPH` (`Solo el párrafo`).

## Caché y score persistido

La caché solo reutiliza un run completado que coincida en versión del modelo,
preprocesamiento, perfil, modo de párrafo y granularidad. Se descarta una entrada si
su `AnalysisRun.documentScore`, `AnalysisModelResult.calibratedScore` o umbral no
coinciden exactamente. Cuando hay hit, se copian al run nuevo el score, umbral,
agregación, clasificación, conteos, resultado del modelo y segmentos; la metadata
registra `cacheHit: true` y el ID de origen. La inferencia fresca registra
`cacheHit: false`.

## Determinismo

La carga del backend Transformer usa `model.eval()` y cada lote de ventanas se
ejecuta dentro de `torch.inference_mode()`. La tokenización desactiva truncamiento y
tokens especiales implícitos; el orden de ventanas usa un `argsort` estable. La
acumulación de resultados por párrafo recorre propietarios en orden ascendente.
Las pruebas automatizadas repiten cinco inferencias sintéticas para V3 y para el
ensemble, sin caché ni cambios de semillas. El backend Transformer confirma que
`eval()` queda activo y las ventanas se ejecutan en `inference_mode()`.

Después de `docker compose build --no-cache`, se enviaron cinco requests
secuenciales frescos a `POST /analysis/paragraphs` con un texto sintético de tres
párrafos. Se usaron el ensemble V2+V3 disponible, perfil `BALANCED`,
`STRICT_PARAGRAPH`, pesos `0.5/0.5`, umbral `0.59` y agregación
`token_weighted_mean`. Las cinco respuestas devolvieron `documentScore` y
`rawDocumentScore` `0.7358070691480104`, las mismas versiones de modelo y tres
párrafos puntuados; el delta absoluto máximo fue `0.0`. El endpoint AI no crea ni
consulta `AnalysisRun`, por lo que estas llamadas no usan la caché de análisis del
backend. Esta medición es solo sobre el fixture sintético y no corresponde al
documento privado ni resuelve su observación 65–66 %.

## Smoke en navegador

Se cargó en la UI el DOCX sintético `turniting-f0062-synthetic-…docx` y quedó
`READY`. El primer run completó con `documentScore = 0.5862033515591658`,
`displayPercent = 59`, `cacheHit = false` y duración de 15.315 s. El segundo run
reutilizó la caché con el mismo score persistido exacto, `displayPercent = 59`,
`cacheHit = true` y duración de 0 ms. Ambos conservaron `ENSEMBLE_V2_V3`,
`BALANCED`, `STRICT_PARAGRAPH`, umbral `0.59` y `token_weighted_mean`; cada uno
mostró tres párrafos evaluados y uno insuficiente. Al seleccionar el run anterior,
el resumen volvió a mostrar sus propios datos. La consola del navegador no registró
errores. La UI no ofrece un control para forzar un fresh run; la reproducibilidad
fresh se midió por separado contra el endpoint interno AI, sin caché del backend.

Las pruebas de componentes cubren errores de historial y segmentos junto con un
run completado para comprobar que el score persiste y los errores quedan acotados.
No se inyectó un fallo de red en el navegador.

## Investigación del 65 % frente a 66 %

El redondeo de una misma fracción puede explicar una diferencia de un punto si dos
vistas usaban valores o reglas distintas. La UI ahora usa el porcentaje canónico del
run persistido; la caché conserva score y metadatos originales. Aún no se puede
atribuir el caso histórico concreto a redondeo, caché, endpoint o inferencia: no se
proporcionaron los IDs de los dos `AnalysisRun` para compararlos. El valor histórico
de 67 % se trata solo como referencia y no se usa para ajustar el modelo.

## Propuesta documental de referencia

Sin migración ni escritura en base de datos, se propone registrar en documentación:

```yaml
reference_case_id: REFERENCE_CASE_EXISTING_001
metric: AI_WRITING_PERCENTAGE
historical_turnitin_percentage: 67
observed_research_percentage: "~65-66 (reportado; AnalysisRun IDs no proporcionados)"
blind: false
use: historical_comparison_only
training: false
validation: false
calibration: false
equivalence_claimed: false
private_text_included: false
```

La etiqueta y los porcentajes no prueban equivalencia entre sistemas. No se registra
un valor exacto de 65 % o 66 % sin localizar primero el `AnalysisRun` que lo produjo.

## Cierre local

La fase queda limitada a la rama `feat/f006-2-1-ui-consistency`. No se crea PR, no se
hace merge y no se despliega. F006 conserva el estado `EXPERIMENTAL_F006_MODEL` /
`UNAVAILABLE`; no se descargan pesos ni se ejecuta inferencia con ese modelo.
