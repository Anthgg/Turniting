# F006.2.2 — Transparencia del análisis contextual

## Modos de párrafo

`STRICT_PARAGRAPH` es el modo predeterminado y recomendado para comparar versiones. El modelo recibe únicamente los tokens del párrafo objetivo. La señal y el score se asignan a ese mismo párrafo.

`CONTEXTUAL_PARAGRAPH` añade hasta 64 tokens finales del párrafo anterior y hasta 64 tokens iniciales del siguiente. El límite se configura con `PARAGRAPH_CONTEXT_TOKENS` (valor predeterminado: 64; rango permitido: 0–128). Si un vecino tiene menos tokens, se usan los que existan. El texto objetivo conserva prioridad: los párrafos largos se dividen en ventanas y se reserva espacio para el contexto; cada score sigue asociado solo al párrafo objetivo. El contexto puede repetirse en las ventanas de un objetivo largo.

Los conteos guardados son los tokens que entraron por lado y por ventana, medidos para cada perfil de preprocesamiento/tokenizador utilizado. No se cambia la puntuación, la agregación, los umbrales ni la clasificación. Un objetivo `INSUFFICIENT_TEXT` no se convierte en evaluable por tener vecinos.

## Qué muestra la interfaz

El panel conserva `Solo el párrafo` como selección inicial y registra el modo histórico desde el `AnalysisRun`. En runs contextuales, las tarjetas indican que se usó contexto y permiten desplegar el párrafo anterior, el objetivo resaltado y el siguiente. La señal queda identificada visualmente como perteneciente al objetivo. En los límites del documento, el vecino ausente aparece como no disponible.

Los párrafos vecinos se reconstruyen bajo demanda desde `DocumentVersion.extractedText` y los offsets persistidos del mismo run. La vista muestra el texto completo de los vecinos como referencia; el modelo solo recibe sus porciones de hasta 64 tokens finales/iniciales. Los conteos exactos se muestran por perfil cuando el run los conserva. Runs históricos anteriores a esta metadata no reciben cifras estimadas: la interfaz indica que el conteo no quedó registrado.

La comparación de versiones advierte cuando cualquiera de los dos runs seleccionados es contextual. Un cambio puede alterar la señal del párrafo cambiado y la de sus vecinos, porque el texto vecino forma parte de su inferencia contextual.

## Privacidad y límites

No se guardan copias de los textos vecinos ni offsets suministrados por el navegador. El endpoint recibe únicamente el ID del run y el ID del segmento, busca ese segmento dentro del run y reconstruye objetivo y vecinos desde la versión enlazada a ese run. Verifica el hash del texto y el hash del objetivo antes de responder; los IDs de otro run no resuelven.

Los conteos describen el uso por ventana y perfil; un objetivo dividido en varias ventanas reutiliza el contexto vecino. Por ello, los conteos no representan la suma total de tokens repetidos a través de todas las ventanas. Una comparación mantiene su lógica y scores existentes; el modo contextual solo agrega una advertencia sobre la interpretación de cambios en párrafos vecinos.
