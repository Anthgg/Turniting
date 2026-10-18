# Integración local F006.1

## Fuente y estado

- Reporte autoritativo: training/reports/F006_1_SPANISH_REPORT.md, rama exp/f006-1-spanish-generalization, commit 714cdafe39977002ee9b84791a4bd8dca05cc57a.
- Gates: training/reports/f006_1/gates.json.
- Modelo: EXPERIMENTAL_F006_1_MODEL, estado EXPERIMENTAL.
- Parent científico: B1_v3; parent del catálogo de producto: CANDIDATE_MODEL_V3.
- No existe una promoción candidata V4 ni un modelo activo. ACTIVE_MODEL permanece NONE.
- El holdout final fue observado una vez y no se reutiliza para tuning.

## Métricas

Holdout final, opción de calibración ES_ISO:

| Medida | Resultado |
| --- | ---: |
| Macro-F1 global | 0.8913 |
| FPR humano global | 0.0555; IC 95% [0.0513, 0.0599] |
| F1 español | 0.9192 |
| FPR humano español | 0.0549; IC 95% [0.0492, 0.0612] |
| Recall español | 0.8916 |
| ECE español | 0.0097 (0.010 redondeado) |
| F1 académico | 0.9286 |
| FPR académico | 0.0163 |
| Recall mixto | 0.6300 |
| F1 AI-edited | 0.9238 |
| F1 OOD | 0.9420 |
| F1 generador no visto | 0.8768 |
| FPR generador no visto | 0.1075 |
| F1 dominio no visto | 0.8394 |
| FPR dominio no visto | 0.0600 |
| Recall adversarial | 0.8725 |
| F1 zero-width / homoglyph / span | 0.880 / 0.879 / 0.826 |

La validación OOF con ES_ISO reporta macro-F1 0.9109, FPR global 0.0478, F1 español 0.9155, FPR español 0.0442 y ECE español 0.0064. El checkpoint de selección del paso 2400 reporta, a umbral 0.9707, FPR global 0.0648, español 0.0627, académico 0.0274 y generador no visto 0.0387. Son vistas con puntos de operación distintos y se mantienen separadas.

Comparación del holdout nuevo (valores redondeados del reporte):

| Métrica | V3 | F006 | F006.1 |
| --- | ---: | ---: | ---: |
| FPR global | 0.069 | 0.047 | 0.055 |
| FPR español | 0.080 | 0.054 | 0.055 |
| F1 global | 0.845 | 0.837 | 0.891 |
| F1 español | 0.864 | 0.857 | 0.919 |

F006.1 obtiene el F1 global y español más alto de esta comparación, pero falla cuatro gates y no es una recomendación de activación.

## Gates

Resultado oficial: **7/11**.

- Fallidos: A overall human FPR (0.0555 > 0.05); D unseen-generator FPR (0.1075 > 0.10); E mixed recall (0.630 < 0.64); H span F1 (0.826 < 0.86).
- Pasados: B español, C académico, F AI-edited, G OOD, I robustez Unicode, J leakage y K disciplina de holdout.
- La estabilidad por párrafo no se evaluó.

## Calibración y serving

El lock registra dos calibradores isotónicos distintos: GLOBAL_ISO para general y ES_ISO para español. Ambos reportan threshold 0.6443; compartir el número no los convierte en el mismo calibrador.

El artefacto local no está instalado. Por ello, el servicio mantiene F006.1 como metadata no servida, sin inferencia sintética, sin prueba de calibración y sin medición de latencia o RAM. El hash de modelo reportado por el registro fuente es c451a0062321189f026a1cc3779f50aa1b398a580d4cedfb9365a9486c835a90; no pudo validarse contra un bundle local. No se proporcionaron checksums separados de config o calibración.

El registro fuente describe la regla español → ES_ISO, general → GLOBAL_ISO, pero el serving local no dispone de un detector de idioma verificado. No se añadió una heurística silenciosa. La selección de calibrador por idioma queda sin verificar.

La interfaz de modelos muestra F006.1 como experimental y no disponible localmente. El selector de Research Analyzer muestra la opción deshabilitada; no se añadió un modo de análisis que no puede ejecutarse con el backend actual.

## Preprocesamiento y párrafos

El lock F006.1 registra V3_CANONICALIZED_V1, vista canonical, max length 512, stride 128 y trimmed_mean. Esos parámetros coinciden con el inference_config.json local de V3, incluido el límite de ocho ventanas por documento. El reporte y el run registran muestras de ventana y párrafo; no acreditan estabilidad independiente por párrafo. La equivalencia de tokenizer y archivos del bundle no puede comprobarse mientras falte el artefacto.

F006.1 no se añade al ensemble. ENSEMBLE_V2_V3 continúa compuesto por V2 y V3 con pesos 0.5/0.5. Se conservan los defaults: ENSEMBLE_V2_V3, BALANCED, STRICT_PARAGRAPH, threshold 0.59 y agregación token_weighted_mean.

## Registry, API y datos

El manifiesto training/datasets/manifests/model_registry_f006_1.json guarda status experimental, active=false, candidate=false, hashes de manifests externos y datasetVersionId=null. El importador registra metadata sin reconstruir filas ni asociar una versión de dataset por nombre. No hay migración de base de datos.

La API de modelos conserva activeModel=NONE y devuelve disponibilidad del artefacto separada del health del servicio. El endpoint de métricas incluye commit fuente, fase y gates. El API de modelos no devuelve rutas de filesystem ni el path lógico de Drive.

El frontend cache key identifica modelo, versión, perfil de threshold/calibración, modo de párrafo, hash de texto/versión, preprocesamiento, granularidad y versión del analizador. Los runs existentes siguen guardando su modelName original.

## Instalar y verificar un bundle futuro

Si se recibe un bundle oficial y se autoriza su uso local, mantenerlo fuera de Git en data/models/experimental-f006-1 (la carpeta data/models/ está ignorada). El contenedor conoce la ruta /data/models/local/experimental-f006-1 mediante AI_MODEL_F006_1_PATH. La ruta fuente MyDrive/... es solo una referencia lógica, no una ruta de Windows.

Copiar el bundle no habilita inferencia por sí solo en esta integración. Antes de servirlo se debe validar su estructura, el SHA-256 del modelo, los archivos de calibración/threshold y el detector de idioma; después hace falta una revisión explícita del loader y pruebas sintéticas. Los casos deben ser texto español sintético, texto inglés sintético y texto académico sintético. Repetir cada entrada cinco veces y medir variación de score solo cuando el loader determinista esté disponible. No usar tesis privadas ni datos de Turnitin.

La salud se comprueba con http://localhost:8000/health y http://localhost:3000/api/health; un modelo ausente debe aparecer como no disponible sin hacer fallar esos endpoints.

## Alcance excluido

Esta integración no entrena, recalibra, cambia thresholds, modifica V2/V3/F006, integra F007, F006.1.1 ni F008, ni crea commits de pesos.
