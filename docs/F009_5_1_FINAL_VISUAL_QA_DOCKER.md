# F009.5.1 — QA visual final y Docker Compose

**Fecha:** 2026-10-21, 12:10 America/Lima<br>
**Rama:** `feat/f009-5-1-final-visual-qa-docker`<br>
**Estado:** QA de navegación responsiva aprobada; QA de resaltado del PDF original parcial.<br>
**PR/merge:** no realizados.

## Alcance y cambio aplicado

Se corrigió la navegación compacta para conservar la misma barra lateral persistente del escritorio. En anchos compactos se muestra un rail fijo de iconos de 72 px; en escritorio la barra expandida conserva 248 px y su control para contraerla. Se eliminaron el botón de menú móvil, el drawer deslizable, el fondo superpuesto y su comportamiento modal. Las rutas permanecen accesibles desde el rail.

Los cambios de interfaz están en `frontend/src/App.tsx` y `frontend/src/App.css`. No se modificaron backend, puntuación, inferencia, modelos, pesos, entrenamiento, datasets, holdout ni umbrales científicos o visuales.

## Revisión responsiva

Se recorrieron Inicio, Documentos, Análisis rápido, Comparación, Reportes, Historial, Modelos y Estado técnico en tres tamaños. Las dimensiones son las medidas efectivas del viewport del navegador.

| Viewport efectivo | Ancho del rail | Overflow horizontal en documento/main | Navegación |
| --- | ---: | ---: | --- |
| 389 × 843 (móvil solicitado: 390 × 844) | 72 px | 0 / 0 en las 8 rutas | `sticky`, transformación `none`, sin control de drawer |
| 768 × 1023 (tablet solicitado: 768 × 1024) | 72 px | 0 / 0 en las 8 rutas | `sticky`, transformación `none`, sin control de drawer |
| 1367 × 764 (escritorio solicitado: 1366 × 768) | 248 px | 0 / 0 en las 8 rutas | `sticky`, transformación `none` |

El análisis rápido también se comprobó en los seis tamaños solicitados: 1920×1080, 1440×900, 1366×768, 1024×768, 768×1024 y 390×844. En todos se mantuvo visible el rail y no hubo overflow horizontal. En escritorio, contraer y expandir la barra cambió entre 248 px y 72 px sin perder la selección de ruta. La consola del navegador registró 0 errores y 0 advertencias durante este recorrido.

## Smoke de análisis rápido y persistencia

Se usó texto sintético de dos párrafos, 187 palabras y 1,218 caracteres, con el marcador `F00951-QA-MOBILE-20261021-ZQ8F`. El análisis terminó y mostró dos párrafos. Tres ejecuciones cálidas midieron 1,176 / 1,104 / 957 ms; mediana 1,104 ms. El marcador no apareció en los logs del servicio de IA revisados.

Los conteos agregados justo antes y después del smoke fueron: documentos 90→90, versiones 90→90 y corridas 121→121. Los reportes pasaron de 175 a 177; el metadato mostró un par `AI_ORIGINAL_REVIEW` / `AI_PARAGRAPH_TECHNICAL` disponible a las 16:43:41Z. El endpoint rápido no crea artefactos de documento, corrida o reporte; por el uso concurrente de la aplicación no se atribuye ese par al smoke ni se declara inmutabilidad de toda la base durante la ventana completa.

## Flujo sintético de documento y reportes

Se cargó un PDF sintético de dos páginas, sin contenido privado, y se ejecutó el modelo V3 ya disponible (sin entrenamiento). El documento de QA es `767db39c-ad7d-414d-b2af-469aa2b733a4`; la corrida es `3d360f53-1748-462f-9a5c-d492c84444e9`. La corrida terminó con seis segmentos evaluados. Las dos variantes quedaron disponibles, se abrieron en la vista previa y se descargaron:

| Variante | Estado | Páginas | Tamaño del archivo descargado |
| --- | --- | ---: | ---: |
| Revisión sobre el original | Disponible | 3 A4 | 6,719 bytes |
| Detalle técnico por párrafos | Disponible | 3 A4 | 48,077 bytes |

Se inspeccionaron visualmente las tres páginas de cada PDF renderizado desde las descargas. Las páginas, el contenido sintético y la estructura del reporte son visibles. Poppler emitió `No display font for 'Symbol'` durante la rasterización; `pdfinfo` confirmó tres páginas A4 por archivo y el texto renderizado permaneció legible.

### Hallazgo que bloquea el PASS completo de reportes

El reporte técnico marca para revisión los seis segmentos con el umbral visual `>20.0 %`. El mapa de fuente registró el segmento sintético `F00951-PAGE2-PARA-1` (segmento 3, señal 92.9 %) como `REVIEW_HIGHLIGHT_NOT_VISUALLY_LOCATED`, sin página ni rectángulos. Por ello ese párrafo aparece en el detalle técnico, pero no queda resaltado en la copia del original. El hallazgo coincide entre el mapa persistido del documento sintético y la inspección visual del PDF. No se sustituyó por una caja aproximada que pudiera señalar texto distinto.

La QA del menú y del layout pasa; la cobertura visual universal del PDF original queda **PARCIAL** hasta corregir el mapeo fuente→página y repetir el flujo sintético.

## Docker Compose local

Docker ya estaba corriendo; no se inició ni reinició el motor. Se reconstruyó `frontend` con `--no-cache` después del cambio de navegación y se actualizó únicamente ese servicio. La compilación completa sin caché de las imágenes locales AI/backend/frontend se había ejecutado antes en esta misma fase; backend y AI no recibieron cambios de código en esta corrección. No se publicó ninguna imagen externamente.

Estado observado al finalizar: `ai-service`, `backend`, `db` y `frontend` en ejecución y `healthy`. Respuestas HTTP: frontend `/` 200; backend `/api/health` 200; base de datos `/api/health/db` 200; proxy AI del backend `/api/health/ai` 200; servicio AI `/health` 200. Compose 2.40.3. No se ejecutó `docker compose down`, no se eliminaron volúmenes y no se reinició la base de datos.

Los volúmenes existentes siguieron presentes: `turniting_turniting_ai_models`, `turniting_turniting_pgdata`, `turniting_turniting_reports` y `turniting_turniting_uploads`.

## Estado de datos al cierre

Después del flujo sintético se esperaban 91 documentos, 91 versiones, 122 corridas y 179 reportes. En la lectura posterior se observaron 92 / 92 / 123 / 181. La pareja de reportes más reciente quedó disponible a las 17:03:48Z. No se abrieron ni alteraron otros documentos; los nombres que aparecen en la página de inicio no se copiaron a este informe y no se consultó su contenido. El incremento adicional de un documento, una versión, una corrida y dos reportes se deja como actividad concurrente no atribuida.

## Calidad y límites

- Frontend: 17 archivos de prueba / 91 pruebas aprobadas; build de producción aprobado tras el cambio; lint termina con código 0 y mantiene la advertencia existente en `AnalysisPanel.tsx:155` (`react(set-state-in-effect)`).
- Backend: 272 pruebas unitarias aprobadas, 13 omitidas; E2E 35/35; build aprobado; lint termina con código 0 y la advertencia existente en `documents.service.ts:765`. No hubo cambios backend en esta corrección.
- AI: `ruff check app` pasó. Pytest de AI no se repitió en el host porque faltan `rapidfuzz` y `pymupdf`; la imagen local no incluye `pytest`.
- `git diff --check` pasó. No hubo entrenamiento, consulta al holdout, publicación de imágenes, PR ni merge.
- La persistencia global durante la QA no puede certificarse con los conteos agregados porque la aplicación tuvo actividad concurrente. El análisis rápido no incrementó documentos, versiones ni corridas en la comparación inmediata.

## Siguiente paso

Corregir y probar con fixtures sintéticos la ubicación visual del segmento 3 que no se mapeó, sin cambiar scores ni umbrales; volver a generar ambas variantes y repetir la inspección del PDF original. Después, completar el gate de QA de reportes.
