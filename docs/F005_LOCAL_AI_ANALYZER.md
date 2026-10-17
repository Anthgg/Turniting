# F005 · Analizador local de señal de IA (pre-integración V2 + V3)

F005 integra localmente, sin entrenar ni modificar pesos, los dos detectores candidatos:
`CANDIDATE_MODEL_V2` (referencia, TURNITING_DATASET_V1) y `CANDIDATE_MODEL_V3`
(`TURNITING_RESEARCH_V3_SPANISH_ACADEMIC`, TURNITING_DATASET_V2). Añade inferencia reproducible,
perfiles de umbral elegidos solo con VALIDATION, un ensemble V2 + V3 experimental, análisis por
párrafo y comparación de versiones. **Ningún modelo queda activado como producción.**

El resultado es una *señal estimada de participación de IA* de un modelo de investigación
independiente: no es un puntaje de Turnitin, no prueba autoría y no debe usarse por sí solo para
tomar decisiones sobre una persona.

Fuera de alcance: entrenamiento, fine-tuning, Colab, descarga de datasets, calibración contra
reportes Turnitin (F007), motor de similitud (F008), Supabase y Cloud Run (F011).

## Arquitectura

```
frontend (detalle de documento · /models · /analysis/compare)
   │  /api
backend NestJS ── AnalysisModule
   │  POST /api/documents/:id/analyze ─► AnalysisRun + AnalysisModelResult + AnalysisSegment (offsets, sin texto)
   │  GET  /api/analyses/:id(/segments)   texto materializado desde DocumentVersion.extractedText
   │  POST /api/analyses/compare      ─► AnalysisComparison (alineación vía ai-service /analysis/align)
   │  GET  /api/models(/:id/metrics)     ModelVersion (F004) + disponibilidad en vivo
   ▼
ai-service FastAPI ── app/services/analyzer
   registry → artifacts (manifest) → ModelManager (lazy, LRU, cola) → backends (torch CPU/CUDA/MPS)
   preprocessing (perfiles versionados) · scoring (ventanas y párrafos) · calibration · ensemble · comparison
```

Endpoints internos del ai-service: `GET /models`, `GET /models/{model}/status`,
`POST /models/{model}/predict`, `POST /models/compare`, `POST /analysis/paragraphs`,
`POST /analysis/compare-versions`, `POST /analysis/align`. `/health` no depende de los modelos.

## Almacenamiento de modelos

Los pesos nunca se versionan. Se importan a `data/models/` (ignorado por Git):

```bash
python scripts/import_model_artifact.py --model CANDIDATE_MODEL_V2 --source "<carpeta calibrated_spanish_academic>"
python scripts/import_model_artifact.py --model CANDIDATE_MODEL_V3 --source "<carpeta v3/models/spanish_academic>"
```

El importador verifica el manifiesto y los archivos requeridos, copia sin modificar, verifica el
SHA-256 de cada archivo (`IMPORT_MANIFEST.json`) y rechaza archivos con aspecto de credenciales.
Rutas configuradas solo en el servidor: `AI_MODEL_V2_PATH`, `AI_MODEL_V3_PATH`,
`AI_BASELINE_MODEL_PATH` (Docker monta `./data/models` en `/data/models/local`, solo lectura).
El frontend nunca envía rutas y la API nunca devuelve rutas locales ni de Drive.

## Ciclo de vida de los modelos

Estados: `UNAVAILABLE` (sin artefacto) → `AVAILABLE` → `LOADING` → `READY`, o `ERROR`
(artefacto inválido o fallo de carga). Carga perezosa, `MODEL_MAX_RESIDENT=1` por defecto (al
cargar V3 se descarga V2), `MODEL_MAX_JOBS=1` (cola simple: dos peticiones nunca cargan dos
transformers a la vez). El ensemble ejecuta V2, luego V3, y fusiona. Dispositivo:
`AI_MODEL_DEVICE=auto|cpu|cuda|mps`. Memoria aproximada: ~1,1 GB por modelo en CPU.

## Preprocesamiento versionado

| Perfil | Unicode | Zero-width | Espacios | Confusables | Ventanas |
|---|---|---|---|---|---|
| `V2_PREPROCESSING_V1` | NFC | se conservan | se conservan | no | 512 tokens, solape 128, ≤ 6 |
| `V3_CANONICALIZED_V1` | NFC | se eliminan | espacios anómalos → espacio | Cirílico/Griego → Latín solo en palabras mixtas | 512/128, ≤ 8 |
| `V3_RAW_V1` | — | se conservan | se conservan | no | 512/128, ≤ 8 |

V3 usa la vista elegida en validation durante su entrenamiento (`inference_config.json`:
`canonical`, `raw` o `avg` = media en log-odds). Un cambio de reglas exige un perfil nuevo.

## Perfiles de umbral y calibración

Perfiles: `BALANCED` (máximo macro F1), `LOW_FALSE_POSITIVE` (máximo recall con FPR ≤ 0,05),
`VERY_LOW_FALSE_POSITIVE` (FPR ≤ 0,02) y `CUSTOM` (umbral enviado en la petición). Calibradores
evaluados: sin calibrar, temperatura, Platt e isotónica; se elige el menor ECE + Brier
fuera de pliegue (CV de 3 pliegues). Todo se ajusta con `ai-service/scripts/f005_calibrate.py`
sobre VALIDATION (V1 validation + adversarial validation [+ V2 validation]); nunca con los tests
congelados, el test V2 ni el holdout externo. Los artefactos quedan en
`ai-service/app/services/analyzer/profiles/*.json` con versión de calibración y hash de los IDs
de validation. Sin perfil F005 se usan los umbrales empaquetados con cada modelo.

## Ensemble V2 + V3 (experimental)

Reglas sin reentrenar: probabilidad ponderada, log-odds ponderados (rejilla w₂ = 0,0…1,0) y
acuerdo conservador (`HIGH_CONFIDENCE` si ambos superan su umbral, `REVIEW` si solo uno,
`LOW_SIGNAL` si ninguno). Puntuación de selección en validation, al umbral LOW_FALSE_POSITIVE de
cada candidato:

```
S = 0.30·macroF1_all + 0.20·macroF1_es + 0.20·macroF1_academic + 0.20·recall_mixed_edited
    + 0.10·recall_adversarial − 2.0·max(0, FPR_all − 0.05) − 1.0·max(0, FPR_es − 0.08)
```

(los términos sin filas en validation se omiten y los pesos se renormalizan).

## Análisis por párrafo

Divisor robusto para texto de DOCX (una línea por párrafo), PDF (líneas cortadas, saltos de página
`\f`), TXT y OCR, con índice, `charStart`/`charEnd`, página y hash. Modos:
`STRICT_PARAGRAPH` (solo el párrafo) y `CONTEXTUAL_PARAGRAPH` (párrafo de hasta 384 tokens + 64
tokens del anterior y del siguiente). Nunca se usan ventanas que cubran varios párrafos, así que
editar un párrafo no mueve a los demás (en modo contextual, como mucho a los vecinos inmediatos).
Párrafos cortos (`MIN_PARAGRAPH_CHARS=120`, `MIN_PARAGRAPH_WORDS=20`, `MIN_PARAGRAPH_TOKENS=32`)
devuelven `INSUFFICIENT_TEXT` en lugar de una probabilidad. La puntuación documental compara en
validation: media, media ponderada por tokens, media recortada, media en log-odds, proporción sobre
el umbral y ponderación por tramo; la opción elegida se guarda en el perfil.

## Comparación de versiones

Alineación ordenada por hash exacto, hash normalizado (minúsculas, sin puntuación ni espacios
extra) y similitud de texto (≥ 0,55): `UNCHANGED`, `MODIFIED`, `ADDED`, `REMOVED`. Se guardan la
diferencia global, los cambios por párrafo y la deriva de los párrafos sin cambios (media, mediana,
p90, p95).

## Privacidad

Los documentos no salen del equipo y el análisis no llama a servicios externos. Los logs contienen
UUID del documento/análisis, modelo, duración y estado; nunca texto. `AnalysisSegment` guarda
offsets y hashes, no el texto. Los tests usan solo fixtures sintéticos (nunca VALIDATION_CASE_001,
reportes Turnitin ni documentos personales).

## Evaluación

```bash
# 1. puntuar (CPU, reanudable) — en un Python con torch + transformers
python ai-service/scripts/f005_score_sets.py --model CANDIDATE_MODEL_V2 --model-path data/models/candidate-v2 --v1-dir <training>
python ai-service/scripts/f005_score_sets.py --model CANDIDATE_MODEL_V3 --model-path data/models/candidate-v3 --v1-dir <training>
# 2. calibración, umbrales y ensemble (solo validation)
python ai-service/scripts/f005_calibrate.py
python ai-service/scripts/f005_paragraphs.py --phase select --model-path data/models/candidate-v3 --v1-dir <training>
# 3. evaluación única en tests + estabilidad
python ai-service/scripts/f005_evaluate.py
python ai-service/scripts/f005_paragraphs.py --phase stability --model-path data/models/candidate-v3 --v1-dir <training>
```

Reportes pequeños en `training/reports/local_analyzer/`; las puntuaciones por documento quedan en
`data/eval/` (ignorado por Git).

## Limitaciones

- V3 en el test V1 congelado tiene FPR 0,275 con su umbral BALANCED original (V2: 0,135); por eso
  los perfiles de bajo falso positivo y el ensemble se eligen en validation. Ver `TRAINING_V3_REPORT.md`.
- En CPU la evaluación usa submuestras estratificadas; los intervalos de confianza son amplios.
- Los párrafos de V1 se construyen sintéticamente (grupos de 3 oraciones) porque esos textos no
  traen saltos de párrafo.
- Ningún perfil ni ensemble es una calibración contra Turnitin (eso es F007).
