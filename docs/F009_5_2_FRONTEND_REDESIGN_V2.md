# F009.5.2 — Rediseño frontend V2

**Fecha:** 2026-10-21 (America/Lima)
**Rama:** `feat/f009-5-2-frontend-redesign-v2`
**Base:** `feat/f009-5-1-final-visual-qa-docker` en `9c49ef338372076838846aef4715bc6d184007c6`
**Alcance:** frontend, selector y consulta de Análisis rápido, documentación y reconstrucción local de Docker Compose.
**PR/merge:** no realizados.

## Resultado

Se continuó desde el estado de F009.5.1 conservando los cambios locales válidos. La referencia visual aplicada fue `redise_o_ui_ux_turniting.html`; `red.html` no se usó como referencia. El HTML sirvió solo para orientar UX/UI: no se copiaron datos de demostración ni JavaScript del prototipo.

La navegación queda en un Dock inferior centrado tipo Mac en escritorio, con sus doce accesos e iconos. En móvil el Dock prioriza Inicio, Documentos, Revisión, Rápido y Más; Más abre la hoja con las otras herramientas. Se añadió el PNG original transparente del usuario como marca y favicon. El nombre Turniting permanece como texto HTML separado del icono.

Análisis rápido conserva el diseño de dos columnas 50/50 en escritorio y se apila en móvil. La configuración permite elegir solo analizadores servables, perfil, modo y, cuando aplica, idioma. El texto se limita a 20.000 caracteres, el usuario puede abortar y limpiar, y los resultados se vinculan a la instantánea analizada para evitar mostrar una respuesta obsoleta. Copiar todo incluye puntuación global, puntuación y texto por párrafo, estado de evaluación y configuración aplicada; copiar un párrafo incluye su puntuación y texto. Este flujo no crea documentos, corridas ni reportes.

La biblioteca muestra la última corrida únicamente cuando el API devuelve una corrida real; no fabrica puntuaciones. La configuración de una corrida recién completada en el panel de análisis puede plegarse y volver a abrirse para reanalizar. Se retiró la consulta global de documentos recientes que no hacía falta en Análisis rápido.

## Marca y assets

- Archivo de producto: `frontend/src/assets/brand/turniting-mark.png`.
- Favicon: `frontend/public/favicon.png`.
- El asset coincide byte a byte con el PNG proporcionado y el favicon coincide con el asset.
- La transparencia se conservó. La palabra Turniting no está dentro de la imagen.

## Docker Compose y modelos locales

Se ejecutó `docker compose up -d --build` para reconstruir el stack local. No se ejecutó `docker compose down` ni se eliminaron volúmenes. PostgreSQL, cargas, reportes y modelos conservaron sus volúmenes nombrados. Después del rebuild, frontend, backend, servicio de IA y base de datos estaban `healthy`.

Consulta en vivo a `/api/models` después del rebuild:

| Analizador | Disponibilidad observada | Servable |
|---|---|---:|
| F006.1 | `AVAILABLE` | Sí |
| F006.1.1 | `READY` | Sí |

La consulta describe el estado del runtime local en esa ejecución; no modifica modelos. El catálogo también contiene agregados históricos de evaluación; no se consultaron registros del dataset holdout ni se ejecutó o ajustó una evaluación con él. No hubo entrenamiento, cambios de pesos, datasets, calibración o umbrales científicos.

## Verificación

- Frontend: 17 archivos de prueba; 100/100 aprobadas. Build TypeScript/Vite aprobado. Oxlint terminó con código 0 y tres advertencias: dos de `only-export-components` en helpers de Análisis rápido y una advertencia `set-state-in-effect` existente en `AnalysisPanel.tsx`.
- Backend: 273 pruebas aprobadas y 13 omitidas; lint y build aprobados. El lint conserva una advertencia `no-control-regex` en `documents.service.ts:765`.
- E2E backend: 35/35 aprobadas en la repetición con acceso local permitido.
- Flujo navegador Quick de extremo a extremo: selección de F006.1.1 → tres párrafos sintéticos → análisis → copiar P1 → copiar todo → limpiar, ejecutado manualmente en Docker. El frontend no tiene configuración Playwright/Cypress; no se presenta como E2E automatizado.
- AI service: Ruff aprobó. La suite Pytest completa llegó a recolectar 74 pruebas, pero no obtuvo veredicto: la ejecución aislada se bloqueó en `tests/test_analyze.py::test_analyze_test_returns_text_metrics`. El volcado mostró que Python 3.14 en Windows esperaba en `socket.accept` dentro de `_fallback_socketpair` mientras `asyncio.run` creaba el bucle, antes de llegar al handler ASGI; también ocurrió con el bucle Selector. Fuera del sandbox, la prueba aislada pasó (1/1 en 2,11 s). La suite completa sigue sin veredicto.
- Docker: cuatro servicios saludables. Volúmenes `turniting_turniting_pgdata`, `turniting_turniting_uploads`, `turniting_turniting_reports` y `turniting_turniting_ai_models` presentes después del rebuild.
- Consola del navegador usado para QA: cero mensajes de error o advertencia.
- Análisis rápido en navegador, sobre texto enteramente sintético: se eligió F006.1.1, perfil Equilibrado, modo `STRICT_PARAGRAPH` e idioma `ES`; la consulta produjo 2 párrafos evaluados y 1 no evaluado. Copiar P1 puso en portapapeles `Párrafo 1 — 15.8%` y su texto. Copiar todo incluyó puntaje global, configuración, P1/P2 con porcentajes y P3 con estado No evaluado. Limpiar dejó vacío el texto y los resultados, y conservó los cuatro selectores.
- El análisis rápido no cambió los conteos agregados de la base: Documento 109, AnalysisRun 141, AnalysisModelResult 139 y AnalysisSegment 24.396 antes y después del smoke. Los valores devueltos por la inferencia se usaron únicamente para validar la interfaz con texto sintético.
- Layout visual comprobado en navegador local servido por Docker: Quick vacío y resultado en escritorio; Quick vacío en viewport 390×844; el Dock móvil mostró cuatro accesos y Más. La hoja Más expuso las ocho herramientas secundarias; Escape la cerró y devolvió el foco al botón Más.
- Capturas de escritorio/móvil se revisaron durante la QA interactiva. No se guardaron archivos de captura al repositorio.

## Alcance visual y límites

No se recorrieron Inicio, biblioteca, detalle, revisión, reportes, modelos, datasets ni estado técnico en el navegador durante esta fase: el backend local contiene documentos preexistentes y no hay un modo `UI_MOCK` en el frontend para sustituirlos por fixtures aislados. Se evitó abrir o capturar datos de documentos reales. Las pruebas de componentes y los builds sí cubrieron los cambios pertinentes, pero no equivalen a una inspección visual de cada ruta.

El hallazgo de mapeo PDF sintético del segmento 3 descrito en F009.5.1 permanece abierto; esta fase no modificó ni revalidó la ubicación fuente→página. No se usaron capturas privadas.

El hash de commit y el resultado del push se registran en el cierre de rama una vez publicados. `git diff --check` pasó sin errores de whitespace (Git emitió solo avisos informativos sobre conversión LF/CRLF).
