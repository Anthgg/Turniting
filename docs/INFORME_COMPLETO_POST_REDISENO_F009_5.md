# Informe completo posterior al rediseño F009.5

**Corte:** 2026-10-21 (America/Lima)
**Rama al cierre de F009.5.1:** `feat/f009-5-1-final-visual-qa-docker`
**HEAD en ese corte:** `9c49ef3` (`fix(frontend): keep desktop sidebar expanded`)
**Estado de publicación en ese corte:** cambios locales pendientes; sin PR ni merge.

## Resumen ejecutivo

F009.5 incorporó una nueva experiencia de frontend y la ruta de Análisis rápido. La primera propuesta usó navegación lateral agrupada. Después de verla, el usuario pidió conservar la barra inferior tipo Mac que tenía antes de F009.5, con los segmentos nuevos y sus iconos. La interfaz local actual muestra ese Dock inferior, no un slider ni un panel lateral.

Después se agregó a Análisis rápido la selección de analizador, perfil, modo de párrafo e idioma para los modelos que requieren calibración lingüística. Se encontró que F006.1.1 estaba oculto si no era el modelo local preferido, aunque el servicio pudiera tenerlo disponible. Se corrigió esa regla: F006.1 y F006.1.1 aparecen habilitados según el estado de disponibilidad informado por el backend; cuando el registro existe pero no se puede usar, aparecen deshabilitados con esa indicación.

El frontend pasó el build tras el último cambio y el contenedor `frontend` se reconstruyó y arrancó. Esto confirma compilación e inicio del contenedor, pero no equivale a una nueva verificación visual en navegador ni confirma el estado actual del artefacto F006.1.1.

## 1. Auditoría que precedió al rediseño

La auditoría F009.5 revisó el router, el grafo de código y las pantallas principales. Identificó páginas que mezclaban carga con biblioteca, revisión con detalles técnicos, y navegación de usuario con administración de modelos/datasets. También señaló falta de una página de Análisis rápido, Historial y Configuración, tablas densas, navegación redundante y dificultades de jerarquía y uso en móvil.

La auditoría no modificó datos ni ejecutó análisis sobre documentos privados. Sus hallazgos y el plan inicial están en [F009_5_FRONTEND_AUDIT.md](./F009_5_FRONTEND_AUDIT.md).

## 2. Trabajo incluido en F009.5

### Análisis rápido

- Se añadió `/analysis/quick` para analizar texto pegado sin crear un documento ni guardar el texto como historial.
- El formulario conserva el texto en memoria del navegador, informa caracteres y palabras y limita la entrada a 20.000 caracteres según `String.length`.
- Incluye estados de carga, error, reintento y limpieza; `Ctrl/Cmd+Enter` inicia el análisis.
- La respuesta presenta señal global, evaluación por párrafo, umbrales y metadatos disponibles. Los párrafos no evaluados se muestran como **No evaluado**, no como cero.
- El flujo original de F009.5 usaba los valores locales preferidos por el backend. La extensión posterior agregó selección explícita de analizador, perfil y modo de párrafo; para F006.1 y F006.1.1 también muestra el idioma de calibración.
- El endpoint sigue usando el servicio de inferencia existente. No se modificaron pesos, entrenamiento, datasets, holdout, scores científicos ni valores de umbral.

### Estructura de la aplicación

- Se reorganizaron Inicio, Documentos, resultados e información técnica; se añadieron Historial y Configuración.
- Inicio prioriza analizar un documento y analizar texto rápido, y muestra actividad reciente.
- Reportes generados por Turniting e informes importados de Turnitin permanecen como flujos separados.
- Se conservan comparación de análisis, catálogos de modelos y datasets y las rutas existentes; las rutas antiguas de configuración se redirigen a sus destinos vigentes.
- La revisión de documento separa el párrafo seleccionado y su contexto en un panel. La versión inicial usó una barra lateral agrupada con drawer móvil; esa propuesta fue reemplazada después del feedback del usuario.

## 3. Ajuste visual solicitado después de F009.5

El usuario indicó que no quería un slider ni la navegación lateral, sino la misma barra de navegación inferior de antes de F009.5, con apariencia de Dock tipo Mac. También pidió incorporar los segmentos nuevos y sus iconos.

La implementación local actual tiene un Dock inferior centrado con estos 12 accesos: **Inicio, Documentos, Revisión, Rápido, Comparar, Reportes, Turnitin, Historial, Modelos, Datasets, Estado y Subir**. Los accesos tienen iconos y nombres accesibles; Revisión se dirige al documento activo y Subir es una acción. En anchos estrechos el diseño los acomoda en dos filas.

La revisión visual registrada comprobó el Dock de escritorio. No se guardó una captura móvil ni se verificó visualmente la disposición de dos filas en móvil, así que ese punto sigue pendiente de confirmación visual.

## 4. Corrección del selector en Análisis rápido

### Causa del F006.1.1 ausente

El selector condicionaba la opción a `localPreferredAnalyzer === EXPERIMENTAL_F006_1_1_MODEL`. Esa variable designa el valor predeterminado local, no todos los modelos que el servicio puede servir. Por eso F006.1.1 desaparecía del menú cuando otro analizador era el preferido.

### Cambio aplicado

- F006.1 y F006.1.1 se presentan cuando el registro de modelos informa que están servables y su disponibilidad es utilizable.
- Si el backend devuelve el registro pero no está listo para servirlo, la opción aparece deshabilitada y explica que no está disponible localmente.
- El modelo preferido continúa definiendo el valor inicial; ya no determina qué opciones utilizables se pueden elegir.
- El backend acepta el analizador, perfil, modo e idioma explícitos y la respuesta devuelve la configuración aplicada.

El estado habilitado de F006.1.1 depende del endpoint de disponibilidad en ejecución. En esta última corrección no se volvió a consultar ese estado ni se ejecutó una inferencia; el cambio del selector no demuestra por sí solo que el artefacto esté instalado y listo.

Como antecedente, una verificación del 18 de octubre registró F006.1 como disponible y servable, aunque inactivo. Ese dato es histórico: no confirma el estado actual de F006.1 ni el de F006.1.1.

## 5. Verificaciones registradas

| Área | Evidencia | Límite |
|---|---|---|
| Frontend F009.5 | 17 archivos / 91 pruebas pasaron; TypeScript y Vite build pasaron; lint salió con código 0 y una advertencia existente en `AnalysisPanel.tsx:155`. | Estos resultados corresponden al cierre F009.5, no a una repetición de la suite después de todos los cambios de navegación y selector. |
| Backend F009.5 | 272 pruebas pasaron, 13 omitidas; E2E 35/35; build pasó; lint salió con código 0 con una advertencia existente en `documents.service.ts:765`. | El build backend también pasó al integrar los parámetros seleccionables de Análisis rápido; no se repitió la suite backend en el último arreglo del selector. |
| AI service | Ruff pasó en el registro de F009.5. | No se repitió su suite en F009.5 porque no hubo cambios de código allí; un intento separado quedó detenido. |
| Análisis rápido sintético | El smoke F009.5 usó dos párrafos sintéticos; no cambió los conteos inmediatos de documentos, corridas ni reportes (88/119/173). Se revisaron logs para el marcador sintético sin encontrarlo. | Ese smoke precede a los selectores recientes; no vuelve a verificar las cuatro combinaciones seleccionables. |
| Dock y Docker Compose | Se revisó el Dock en escritorio. El registro F009.5.1 informó los cuatro servicios saludables y respuestas HTTP 200 para frontend, backend, DB y AI. Se conservaron volúmenes. | En el último cambio se reconstruyó solamente `frontend`; el resultado del comando confirmó que quedó iniciado, pero no se volvió a consultar el estado de salud de todos los servicios. |
| Build del último cambio | `npm run build` de frontend pasó (TypeScript y Vite; 209 módulos). `git diff --check` del archivo del selector no reportó errores de whitespace. | No se ejecutaron pruebas automatizadas ni una prueba visual/API después de este último cambio. |

### Verificación de reportes PDF

En el flujo sintético F009.5.1 se cargó un PDF de dos páginas y se generaron ambas variantes: revisión sobre el original (3 páginas A4, 6.719 bytes) y detalle técnico por párrafos (3 páginas A4, 48.077 bytes). Se descargaron y se inspeccionaron visualmente las páginas renderizadas.

El gate completo sigue **PARCIAL**: el mapa de fuente no encontró ubicación visual para el párrafo sintético `F00951-PAGE2-PARA-1`, segmento 3, con señal 92,9 %. El informe técnico lo incluye, pero no aparece resaltado en la copia del original; el registro lo marcó `REVIEW_HIGHLIGHT_NOT_VISUALLY_LOCATED` sin página ni rectángulos. No se añadió una ubicación aproximada porque podría resaltar texto equivocado.

## 6. Datos, privacidad y límites de atribución

- Los smokes de Análisis rápido usaron texto sintético y el endpoint no crea documentos, corridas, segmentos ni reportes.
- La prueba de reportes sí creó intencionalmente un documento sintético (`767db39c-ad7d-414d-b2af-469aa2b733a4`) y una corrida (`3d360f53-1748-462f-9a5c-d492c84444e9`). El informe de QA registró actividad adicional concurrente en la base; sus incrementos no se atribuyen todos al smoke y no se afirma que la base completa permaneciera inmutable.
- No se abrió ni se incluyó contenido de documentos privados en el informe de QA.
- Docker Compose no se bajó; no se reinició la DB ni se eliminaron volúmenes. No hubo publicación externa de imágenes.

## 7. Estado Git y publicación

- Rama actual: `feat/f009-5-1-final-visual-qa-docker`.
- `HEAD` local: `9c49ef3`; una confirmación por delante de `origin/feat/f009-5-1-final-visual-qa-docker` en la última lectura.
- Hay 9 archivos versionados con cambios locales sin confirmar: servicio y DTO de análisis rápido, API y página rápida, CSS/UI, icono, y los informes F009.5.1. Este informe es un archivo nuevo sin seguimiento, creado para entregar la consolidación solicitada.
- El título del commit `HEAD` todavía dice “keep desktop sidebar expanded”; el código local sin confirmar reemplaza esa navegación por el Dock inferior solicitado. Para entender la pantalla actual hay que considerar tanto `HEAD` como los cambios del árbol de trabajo.
- F009.5 tuvo sus commits `7e58c5f` y `b1bb07b`; el commit `7e58c5f` quedó en su rama de rediseño. Las modificaciones posteriores del Dock y los selectores no están todas consolidadas en la rama actual.
- No se creó PR ni se hizo merge. La corrección del selector no fue publicada.

## 8. Pendientes recomendados

1. Corregir y verificar con fixtures sintéticos el mapeo fuente→página del segmento 3 y repetir la descarga/inspección de ambos PDF.
2. Hacer una revisión visual móvil del Dock y sus dos filas, además del escritorio ya revisado.
3. Consultar el endpoint de modelos para confirmar si F006.1.1 aparece habilitado o deshabilitado en esta ejecución local; luego verificar el selector en la app sin analizar documentos privados.
4. Ejecutar los gates que correspondan al cierre de la rama después de decidir el alcance final; los resultados de suites de F009.5 no cubren automáticamente las modificaciones locales posteriores.

## Documentos fuente

- [Auditoría frontend previa al rediseño](./F009_5_FRONTEND_AUDIT.md)
- [Rediseño F009.5 y verificación integrada](./F009_5_QUICK_ANALYZER_FRONTEND_REDESIGN.md)
- [QA visual y Docker Compose F009.5.1](./F009_5_1_FINAL_VISUAL_QA_DOCKER.md)

## 9. Actualización F009.5.2 — rediseño V2 y cierre local

**Fecha:** 2026-10-21 (America/Lima). Esta sección amplía el historial sin reemplazar las observaciones de F009.5 y F009.5.1.

Se conservó el estado válido local y se trabajó en `feat/f009-5-2-frontend-redesign-v2`, a partir del commit F009.5.1 `9c49ef338372076838846aef4715bc6d184007c6`. La referencia correcta fue `redise_o_ui_ux_turniting.html`; `red.html` no se usó. Se integró el PNG transparente original como `frontend/src/assets/brand/turniting-mark.png` y `frontend/public/favicon.png`; ambos assets se verificaron coincidentes, con transparencia preservada y texto Turniting separado en React.

El Dock inferior tipo Mac contiene los doce accesos solicitados en escritorio. En móvil expone Inicio, Documentos, Revisión, Rápido y Más; la hoja Más lista Comparar, Reportes, Turnitin, Historial, Modelos, Datasets, Estado y Subir. Análisis rápido usa layout 50/50 desktop y columnas apiladas en viewport 390×844; selecciona analizador servable, perfil, modo y el idioma cuando aplica; limita la entrada a 20.000 caracteres; permite copiar párrafos y salida completa; y limpia el texto y resultados, conservando la configuración. El resultado del smoke se relaciona con la instantánea analizada. La biblioteca solo presenta el análisis más reciente si existe una corrida real devuelta por el API.

### QA y evidencias de esta fase

- Frontend: Vitest 100/100 en 17 archivos; build aprobado. Oxlint terminó con código 0 y tres advertencias registradas en [F009_5_2_FRONTEND_REDESIGN_V2.md](./F009_5_2_FRONTEND_REDESIGN_V2.md).
- Backend: 273 pruebas aprobadas, 13 omitidas; build y lint aprobados. E2E 35/35 aprobadas.
- Flujo de Análisis rápido probado manualmente de punta a punta en navegador Docker con modelo, texto sintético, copia individual, copia completa y limpieza; no hay configuración Playwright/Cypress frontend para reportarlo como E2E automatizado.
- Servicio de IA: Ruff aprobado. La suite Pytest recolectó 74 pruebas, pero queda sin veredicto. Un volcado de la prueba detenida identificó una espera en `socket.accept` dentro de `_fallback_socketpair` de Python 3.14/Windows durante la creación del bucle asyncio, antes de ejecutar el handler ASGI. La prueba aislada `tests/test_analyze.py::test_analyze_test_returns_text_metrics` pasó fuera del sandbox (1/1 en 2,11 s). Ese resultado no sustituye la suite completa.
- Compose se reconstruyó con `docker compose up -d --build`. AI, backend, DB y frontend quedaron `healthy`. Volúmenes de DB, cargas, reportes y modelos se encontraron presentes; no se ejecutó `down` ni se borraron volúmenes.
- Consulta en vivo posterior al rebuild: F006.1 `AVAILABLE` y servable; F006.1.1 `READY` y servable.
- En navegador servido por Docker se inspeccionaron Quick vacío y resultado en escritorio, Quick vacío a 390×844, los cuatro accesos del Dock móvil y la hoja Más. Escape cerró la hoja y devolvió el foco. La consola de esa pestaña no registró errores ni advertencias.
- El smoke de tres párrafos fue enteramente sintético. Dio dos evaluados y uno No evaluado. Copiar P1 produjo porcentaje y texto correctos; copiar todo incluyó score global, todos los párrafos y su estado, analizador, perfil, modo e idioma. Después de Limpiar, entrada/resultados quedaron vacíos y los cuatro selectores conservaron su valor.
- Conteos agregados antes y después del smoke: Documento 109, AnalysisRun 141, AnalysisModelResult 139, AnalysisSegment 24.396; no variaron.
- No se abrió ni capturó ninguna vista de documentos preexistentes. No hubo entrenamiento ni evaluación sobre holdout; no se alteraron modelos, pesos, datasets, calibración, scores o thresholds científicos. El endpoint local del catálogo devuelve agregados históricos además del estado de servicio; no se consultaron filas del dataset holdout ni se usaron esos agregados para ajustar.

### Cobertura que queda pendiente

No se completó QA visual de Inicio, Documentos, Detalle, Revisión, Reportes, Modelos, Datasets y Estado: esas rutas pueden revelar datos locales existentes y el frontend no dispone de modo `UI_MOCK` o fixtures aislados para reemplazarlos de forma segura. Tampoco se verificaron todos los anchos del plan. Las capturas de Quick desktop/mobile se revisaron durante la interacción, pero no se guardaron como archivos del repositorio. El mapeo fuente→página del segmento sintético 3 de reportes PDF sigue parcial según F009.5.1.

### Publicación

`git diff --check` pasó sin errores de whitespace (Git mostró avisos informativos de conversión LF/CRLF). El trabajo F009.5.2 está en la rama `feat/f009-5-2-frontend-redesign-v2`; no se abrió PR ni se hizo merge.
