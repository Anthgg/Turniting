# F009.5.2 — Auditoría frontend

**Fecha:** 2026-10-21
**Rama de trabajo:** `feat/f009-5-2-frontend-redesign-v2`
**Base inspeccionada:** commit `9c49ef338372076838846aef4715bc6d184007c6` y sus cambios locales preservados.

## Antes

- El árbol de trabajo ya contenía cambios posteriores a F009.5; se conservaron y se trabajó en la rama dedicada F009.5.2.
- El commit de base aún describía un sidebar expandido; el requerimiento vigente era mantener el Dock inferior tipo Mac solicitado anteriormente.
- La vista rápida necesitaba alinear el selector con disponibilidad real, permitir copiar cada resultado y toda la salida, limpiar contenido y proteger el resultado respecto de la instantánea analizada.
- El acceso global a documentos recientes podía disparar consultas innecesarias en una ruta de texto aislado.
- La lista de documentos debía basarse en corridas reales para presentar datos de análisis.

## Problemas y riesgos identificados

- Usar el modelo local preferido como lista de opciones ocultaba analizadores que sí estaban servables.
- Un resultado podía dejar de corresponder al texto y configuración visibles si estos cambiaban durante la solicitud.
- El formato de copia debía conservar global, puntuaciones y texto por párrafo, incluso el estado no evaluado.
- La interfaz tenía que mantener una sola fuente para el icono de marca, sin texto incrustado o favicon diferente.
- El entorno local contiene documentos preexistentes; navegar la biblioteca o vistas de documentos podía exponer datos ajenos al smoke sintético.

## Decisiones

- Se usó `redise_o_ui_ux_turniting.html` como referencia visual y `red.html` quedó descartado.
- Se preservó el Dock inferior: doce destinos en escritorio y cuatro accesos más Más en móvil.
- El PNG fue integrado como asset local, sin carga externa ni conversión a JPG.
- La biblioteca presenta análisis solo a partir del API, sin scores de ejemplo.
- El smoke se limitó a Análisis rápido con párrafos inventados; luego se limpió. No se abrió una ruta que liste o muestre documentos existentes.
- No se tocaron reglas científicas, thresholds, modelos, pesos, entrenamiento o datasets. El registro local de modelos incluye agregados históricos; no se leyeron filas del holdout ni se ejecutó o ajustó una prueba con esos datos.

## Cambios revisados

- Dock, iconografía, comportamiento del panel Más, nombre y marca Turniting, favicon y estilos responsive.
- Configuración de Análisis rápido: selector de analizador servable, perfil, modo e idioma condicionado por el analizador; límite de 20.000 caracteres, abortar/limpiar, instantánea, protección de doble envío y filtros de resultados.
- Copia de un párrafo y de todo el resultado en texto plano; la salida incluye score global, texto y score individual y configuración, y representa explícitamente lo no evaluado.
- Lista de documentos basada en el run real más reciente y presentación plegable de parámetros tras una corrida recién completada.
- Retiro de una consulta global innecesaria de documentos recientes en el layout.
- DTO y servicio de análisis rápido para pasar y devolver la configuración solicitada sin persistir el contenido.

## Después

- Frontend: 100/100 pruebas, build aprobado, lint con salida 0 y tres advertencias documentadas.
- Backend: 273 aprobadas, 13 omitidas, build y lint aprobados; E2E 35/35 aprobadas.
- Flujo navegador de Quick: probado manualmente de punta a punta con F006.1.1 y texto sintético. No existe configuración Playwright/Cypress en el frontend, así que esta evidencia no sustituye un E2E automatizado.
- Docker Compose reconstruido; los cuatro servicios terminaron saludables y los volúmenes existentes siguen montados.
- Model registry consultado tras el build: F006.1 `AVAILABLE`/servable y F006.1.1 `READY`/servable.
- QA interactiva en Docker local: desktop y 390×844; Dock móvil y hoja Más verificados. Escape cerró la hoja y devolvió foco.
- Quick smoke con tres párrafos sintéticos: 2 evaluados y 1 no evaluado; portapapeles de P1 y salida global comprobados; limpieza confirmó entrada vacía, resultados reseteados y selectores conservados.
- Los conteos de Documento, AnalysisRun, AnalysisModelResult y AnalysisSegment permanecieron en 109, 141, 139 y 24.396.
- No hubo errores ni advertencias de consola en la pestaña usada para QA.

## Limitaciones y pendientes

- Pytest de AI service recogió 74 pruebas, pero la suite completa queda sin veredicto. El volcado de la prueba detenida mostró que Python 3.14/Windows esperaba en `socket.accept` dentro de `_fallback_socketpair` al crear el bucle asyncio, antes de ejecutar la petición ASGI. Ruff pasó y la prueba aislada pasó fuera del sandbox (1/1 en 2,11 s); no se reporta PASS de la suite completa.
- No se hizo inspección visual de Inicio, Documentos, Detalle, Revisión, Reportes, Modelos, Datasets ni Estado porque esas rutas pueden exponer documentos reales y la app no ofrece un fixture/mock UI aislado. No se atribuye PASS visual a esas rutas.
- Las capturas del navegador se revisaron de forma interactiva; no hay PNG guardados en el repositorio. Las imágenes privadas no se capturaron.
- El mapeo fuente→página del segmento sintético 3 del PDF sigue siendo el límite PARCIAL documentado en F009.5.1.
- La cobertura visual de resoluciones fue escritorio por defecto y 390×844. No se verificaron todos los anchos 1920, 1440, 1366, 1024, 768, 430 y 360 solicitados en el plan.

## Estado científico y de datos

Sin entrenamiento, evaluación sobre holdout, modificación de modelo/pesos/dataset/calibración, ni cambios de score o thresholds. El catálogo local incluye agregados históricos, pero no se leyeron filas del holdout ni se usaron para ajustar. Los análisis rápidos de QA no escribieron documentos, corridas, reportes o segmentos. No se inspeccionó texto de documentos preexistentes.
