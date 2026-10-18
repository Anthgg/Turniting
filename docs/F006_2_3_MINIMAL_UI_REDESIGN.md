# F006.2.3 — Rediseño visual minimalista full-width

## Principios visuales

Esta fase aplica un rediseño visual sobrio y de estilo editorial/desktop sobre el frontend de Turniting, priorizando la lectura y la inspección de señales por párrafo sin modificar la lógica de negocio, modelos, umbrales, agregación ni endpoints de inferencia.

Los principios aplicados son:
- **Paleta reducida**: fondo general gris-pizarra muy suave (`#f8fafc`), superficies blancas (`#ffffff`), texto principal en slate profundo (`#0f172a`), texto secundario en gris medio (`#64748b`), bordes finos (`#e2e8f0`) y un único acento principal en verde Turniting (`#147a6d`), reservando el ámbar discreto (`#9a6715`) para advertencias puntuales.
- **Menos contenedores y menos bordes**: se eliminan las tarjetas anidadas ("caja dentro de otra caja"), las sombras pesadas y los degradados decorativos. La jerarquía se establece mediante tipografía (`Inter`), alineación y espacio en blanco.
- **Tipografía y contraste**: números tabulares de gran escala para la señal global del documento, encabezados concisos y ancho de línea legible para el texto de cada párrafo.

## Decisiones de layout

1. **Ancho completo real (`full-width`)**:
   - Se mantiene la estructura de navegación fija a la izquierda (`232px`) y contenido principal a la derecha.
   - Se elimina la restricción `max-width: 1320px` centrada en `.dashboard-main`; el contenedor principal ocupa el 100 % del ancho útil de la pantalla con padding horizontal fluido (`clamp(28px, 4vw, 64px)`).
2. **Sidebar simplificada**:
   - Fondo oscuro plano (`#0f172a`), sin tarjetas apiladas de cambio de espacio ni recuadros ornamentales.
   - Íconos discretos (`17px`), estado activo limpio y un pie minimalista para indicar la fase actual.
3. **Header del documento e integración de navegación**:
   - Muestra ruta (`Documentos / Formato`), título del archivo, estado y metadatos clave en una sola línea, junto con las acciones principales a la derecha.
   - Los tabs (`Análisis de investigación` y `Documento y extracción`) usan un estilo de pestaña inferior discreta sobre el divisor del encabezado, acompañados a la derecha por un selector segmentado compacto para alternar entre `Research · experimental` y `F005 existente`.
4. **Toolbar horizontal del analizador**:
   - Los controles de `Analizador`, `Perfil`, `Modo de párrafo`, `Ejecución` (historial) y el botón `Analizar IA` se agrupan en una sola barra horizontal alineada.
5. **Resumen con jerarquía visual**:
   - En lugar de múltiples tarjetas equivalentes, el bloque `.analysis-summary-band` presenta a la izquierda la métrica principal (**Señal global** en tipografía grande junto a su nivel y estado) y a la derecha una rejilla ligera sin bordes individuales (`.analysis-meta-grid`) con estado, `Run ID`, fecha, analizador, perfil, modo de párrafo, umbral, duración, `cacheHit`, conteo de párrafos y agregación.
6. **Lista de párrafos como centro de la vista**:
   - Encabezada por una barra compacta con el conteo total y los selectores en línea de filtro por nivel y orden.
   - Cada fila muestra número de párrafo, puntaje porcentual, nivel de señal y vista previa del texto. Las etiquetas técnicas del modelo y versión pasan a un desplegable secundario (`Detalles técnicos`) para no saturar la lectura inicial.

## Reducción de ruido visual

- Se reemplazaron los múltiples bloques de avisos apilados en la parte superior por un subtítulo breve de descargo experimental bajo el título de la sección y una única nota compacta cuando `F006` no está disponible para inferencia.
- Se eliminó la lista permanente de cápsulas de estado de modelos cuando los artefactos requeridos están operativos, conservando únicamente los avisos cuando existe indisponibilidad o error real.
- Se retiraron las ilustraciones decorativas y paneles con gradientes en el tablero inicial en favor de secciones abiertas delimitadas por líneas divisorias sutiles.

## Conservación de `STRICT_PARAGRAPH` vs `CONTEXTUAL_PARAGRAPH`

Todo el comportamiento introducido en F006.2.2 permanece intacto:
- `STRICT_PARAGRAPH` (`Solo el párrafo · Recomendado`) continúa siendo la selección predeterminada para nuevas ejecuciones. En runs estrictos no se muestran indicadores ni controles de contexto vecino.
- `CONTEXTUAL_PARAGRAPH` (`Con contexto breve · Experimental`) sigue disponible en la barra de configuración con su ayuda contextual (`ⓘ`) y una nota breve cuando está seleccionado.
- En runs contextuales, cada párrafo evaluado muestra un indicador discreto (`Contexto utilizado`) y la acción `Ver contexto utilizado`, que despliega un cajón limpio de tres columnas (`Anterior`, `Párrafo evaluado`, `Siguiente`) con los conteos de tokens por ventana y perfil, manteniendo explícito que el porcentaje pertenece exclusivamente al párrafo objetivo.

## Claridad y trazabilidad en runs históricos

- El selector `Ejecución` integrado en la toolbar permite alternar entre cualquier `AnalysisRun` previo del documento.
- La banda de resumen y la lista de párrafos leen siempre la configuración persistida del run seleccionado (`analyzerMode`, `thresholdProfile`, `paragraphMode`, `documentScorePercent`, `threshold`, `inferenceMs`, `cacheHit`), independientemente de los valores elegidos en los controles para un próximo análisis.
- Se conserva la validación `segmentsBelongToRun` y el aislamiento de errores por operación (historial, segmentos, inferencia y contexto), garantizando que un fallo secundario no oculte el resultado de un run completado.
