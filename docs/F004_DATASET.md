# F004 · Formalización de datasets e integración de artefactos de entrenamiento

F004 registra dentro de Turniting el trabajo de entrenamiento ya realizado en la rama
`exp/ai-detector-training` **sin volver a entrenar ni descargar datos**. Formaliza versiones de
dataset, fuentes, licencias, procedencia, splits, hashes, estadísticas, artefactos, metadata de
modelos y la preparación de `TrainingSample` a partir de la ground truth de F002.

No forma parte de F004: entrenamiento, Colab, descarga de pesos, integración de inferencia
(F005/F006), calibración contra Turnitin (F007), motor de similitud (F008), Supabase y Cloud Run (F011).

## Arquitectura

```
PUBLIC DATASETS (HF · Zenodo · GitHub)
      ↓  training/scripts/download_datasets.py + build_dataset.py
training pipeline (Parquet local, fuera de Git y de PostgreSQL)
      ↓
TURNITING_DATASET_V1  ── manifests + estadísticas versionados en training/
      ↓  POST /api/datasets/register  (solo metadata)
DatasetVersion
      ├── DatasetSource          (licencia, uso comercial, filas, pesos de muestreo)
      ├── DatasetArtifact        (manifests, reportes, configs, shards Parquet externos)
      └── TrainingSplitManifest  (filas por split, hash del split manifest)
             ↓  POST /api/model-versions/import-registry
       ModelVersion
             ├── BEST_BASELINE        (EXPERIMENTAL)
             └── CANDIDATE_MODEL_V2   (CANDIDATE · RESEARCH_ONLY · pesos en Google Drive)

TURNITIN REPORT (F002)
      ↓
GroundTruthCase ─→ TurnitinSegment
      ↓  POST /api/datasets/:id/import-ground-truth/:caseId
TrainingSample (solo AI_FLAGGED → MACHINE candidato, PRIVATE)
      ↓  npm run export:training-samples
futuras versiones de dataset (nunca mezcladas automáticamente con el público)
```

## Principio de almacenamiento

PostgreSQL **no** guarda el millón de filas públicas. Guarda versiones, metadata, fuentes,
procedencia, estadísticas, artefactos, hashes, splits y las muestras locales derivadas de
Turnitin. Los Parquet (`training/datasets/normalized/`) y los pesos se quedan fuera del repo y de
la base de datos; se referencian como artefactos externos con su SHA-256 tomado del manifiesto.

## Modelo de datos (migración `20261017030000_f004_dataset`)

| Modelo | Uso |
|---|---|
| `DatasetVersion` | `name` + `version` (único), estado `DRAFT/BUILDING/READY/INVALID/ARCHIVED`, conteos, dedup, `leakageStatus`, rutas de manifiesto y estadísticas, `metadata.statistics` (distribuciones resumidas) |
| `DatasetSource` | una fila por dataset de origen: estado (`INCLUDED`, `BLOCKED_ACCESS`, …), URL, tipo, licencia, `licenseStatus`, `commercialUseStatus`, filas disponibles/usadas, español, académico, peso de muestreo, SHA-256 |
| `DatasetArtifact` | manifiesto, auditoría de licencias, estadísticas, split manifest, shard Parquet, reporte de entrenamiento/evaluación, config, pesos de modelo. `storageProvider` = `REPOSITORY`, `LOCAL` o `GOOGLE_DRIVE`; `external` indica que no vive en el repo |
| `TrainingSplitManifest` | filas por split (`TRAIN`, `VALIDATION`, `TEST`, `OOD`, `ADVERSARIAL_TEST`, `ADVERSARIAL_VALIDATION`, `UNSEEN_GENERATOR_TEST`, `UNSEEN_DOMAIN_TEST`, `MIXED`) y hash del manifiesto. Los cientos de miles de IDs quedan en el archivo, no en la BD |
| `TrainingSample` | muestras locales: etiqueta `HUMAN/MACHINE/MIXED/UNKNOWN`, `labelSource`, split, `eligibleForTraining`, `privacyClass` (`PUBLIC/PRIVATE/SYNTHETIC`), vínculos a `DocumentVersion`, `TurnitinSegment`, `GroundTruthCase`. Único por `(datasetVersionId, turnitinSegmentId)` |
| `ModelVersion` | nombre único, arquitectura, variante, estado `EXPERIMENTAL/CANDIDATE/ACTIVE/RETIRED/INVALID`, tipo, entorno de entrenamiento, `commercialEligibility`, proveedor y ruta lógica del artefacto, métricas, thresholds, calibración, limitaciones |

No se modificaron migraciones de F000–F003.

## TURNITING_DATASET_V1

Registrado desde `training/datasets/manifests/*.json` y `training/reports/dataset_statistics.json`:

| Métrica | Valor |
|---|---:|
| filas conservadas | 1,338,257 |
| humano / máquina / mixto | 437,866 / 885,273 / 15,118 |
| español / académico | 76,540 / 114,862 |
| idiomas / dominios / familias de generadores | 27 / 15 / 21 |
| duplicados exactos / near-duplicates eliminados / conflictos de etiqueta | 625,144 / 15,795 / 10 |
| leakage (grupos, hashes exactos, pares near-dup entre train y evaluación) | 0 / 0 / 0 → `PASS` |

### Fuentes y licencias

| Fuente | Licencia | `licenseStatus` | Uso comercial |
|---|---|---|---|
| iberautextification | CC-BY-NC-ND-4.0 | NON_COMMERCIAL_ONLY | NOT_ALLOWED |
| autextification2023 | CC-BY-NC-SA-4.0 | NON_COMMERCIAL_ONLY | NOT_ALLOWED |
| semeval2024_task8 | no declarada | UNDECLARED | UNCLEAR |
| m4 | no declarada | UNDECLARED | UNCLEAR |
| mage | Apache-2.0 | ALLOWED | ALLOWED |
| hc3 / hc3_chinese | CC-BY-SA-4.0 | ALLOWED | ALLOWED |
| raid | MIT | ALLOWED | ALLOWED |
| turingbench | Apache-2.0 | ALLOWED | ALLOWED |
| ghostbuster_essay | CC-BY-3.0 | ALLOWED | ALLOWED |
| multitude | CC-BY-4.0 (acceso restringido) | BLOCKED | UNCLEAR — **no utilizado** |

La UI muestra de forma visible: *"Este dataset/modelo incluye fuentes con restricciones no
comerciales."* Las licencias no comerciales nunca se reinterpretan como comerciales; esta
clasificación prepara una futura `TURNITING_COMMERCIAL_DATASET_V1`.

## Modelos registrados

Las métricas se leen de `training/datasets/manifests/model_registry.json`, generado por
`training/scripts/make_model_registry.py` a partir de los reportes. No están en el código.

| | BEST_BASELINE | CANDIDATE_MODEL_V2 |
|---|---|---|
| arquitectura | stacked TF-IDF LR/SVM + stylometric GBM | microsoft/mdeberta-v3-base (`CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER_GPU`) |
| estado | EXPERIMENTAL | CANDIDATE (nunca ACTIVE en F004) |
| uso | RESEARCH_ONLY | RESEARCH_ONLY |
| artefacto | LOCAL `training/models/baseline/best` | GOOGLE_DRIVE `MyDrive/turniting/workdir/models/gpu/calibrated_spanish_academic` (1.1 GB, no descargado) |
| primaria validation (es+acad) | 0.909 | 0.927 |
| test / español / académico / OOD macro F1 | 0.864 / 0.852 / 0.916 / 0.790 | 0.889 / 0.869 / 0.909 / 0.861 |
| thresholds registrados | BALANCED 0.525 · LOW_FP 0.900 · HIGH_PRECISION 0.655 | BALANCED 0.505 · LOW_FP 0.875 · HIGH_PRECISION 0.585 |
| limitaciones | FPR OOD alto; paráfrasis | zero-width (recall 0.07), homoglyph (0.42), académico-test ligeramente bajo el baseline, FPR OOD alto, licencias no comerciales |

Los thresholds **no** se aplican a documentos de usuarios en F004. No se guardan credenciales ni
URLs firmadas; solo proveedor y ruta lógica.

## Ground truth → TrainingSample

`POST /api/datasets/:id/import-ground-truth/:caseId`:

1. verifica el `GroundTruthCase` (`AI_REPORT` con reporte `AI_WRITING`);
2. rechaza casos `VALIDATION` y cualquier `VALIDATION_CASE_*` (reservados para comparación ciega);
3. crea muestras `MACHINE` solo desde segmentos `AI_FLAGGED`, con `labelSource = TURNITIN_AI_FLAGGED`,
   `privacyClass = PRIVATE` y procedencia (reporte, segmento, página, offsets, score);
4. **`NOT_FLAGGED` nunca se convierte en `HUMAN`**: se cuenta y se omite;
5. los segmentos de similitud nunca son etiquetas de IA;
6. es idempotente por `(datasetVersionId, turnitinSegmentId)`.

El texto privado no se devuelve por la API (`textRedacted: true`), no se registra en logs ni en
manifests, y solo se exporta con `--include-private-text` a una carpeta ignorada por Git.

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/datasets` | versiones con conteos y advertencias de licencia |
| POST | `/api/datasets/register` | registra `name`/`version`; con `manifestPath`/`statisticsPath` importa en el mismo paso |
| GET | `/api/datasets/:id` | detalle, splits y modelos asociados |
| GET | `/api/datasets/:id/sources` | fuentes y licencias |
| GET | `/api/datasets/:id/artifacts` | artefactos (repo, locales y externos) |
| GET | `/api/datasets/:id/statistics` | conteos, dedup, leakage y distribuciones |
| GET | `/api/datasets/:id/samples` | `TrainingSample` paginados (`label`, `labelSource`, `split`, `language`, `eligibleForTraining`) |
| GET | `/api/datasets/:id/models` | modelos del dataset |
| POST | `/api/datasets/:id/import-manifest` | valida e importa manifests (schema versionado) |
| POST | `/api/datasets/:id/import-ground-truth/:caseId` | AI_FLAGGED → MACHINE candidatos |
| GET | `/api/model-versions`, `/api/model-versions/:id` | metadata de modelos |
| POST | `/api/model-versions/register` | registro individual validado (no acepta ACTIVE) |
| POST | `/api/model-versions/import-registry` | importa `model_registry.json` para un dataset |

Las rutas de manifiesto son relativas a `TRAINING_DIR` y no pueden salir de él. Los manifests se
validan con esquemas versionados (`datasetManifestSchemaVersion = 1`, `modelRegistrySchemaVersion = 1`);
un JSON arbitrario se rechaza con `400` y la lista de problemas.

## Registro local

```bash
# backend en marcha (Docker monta ./training en /app/training:ro)
curl -X POST http://127.0.0.1:3000/api/datasets/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"TURNITING_DATASET","version":"V1","manifestPath":"datasets/manifests","statisticsPath":"reports/dataset_statistics.json"}'

curl -X POST http://127.0.0.1:3000/api/model-versions/import-registry \
  -H 'Content-Type: application/json' -d '{"datasetVersionId":"<id>"}'
```

Exportar muestras locales (JSONL, no se mezcla con el dataset público):

```bash
cd backend
npm run export:training-samples -- --dataset <id> [--eligible-only] [--include-private-text]
```

## Pipeline de entrenamiento en el repo

`training/` contiene código, configs, manifests, reportes y tests reproducibles
(`download_datasets.py`, `build_dataset.py`, `train_baseline.py`, `train_transformer.py`,
`calibrate.py`, `evaluate.py`, `predict*.py`, notebook de Colab). Datos crudos/normalizados,
cache, modelos y checkpoints están en `.gitignore` y fuera de la imagen Docker. En F004 solo se
ejecutan sus tests unitarios; no se entrena.
