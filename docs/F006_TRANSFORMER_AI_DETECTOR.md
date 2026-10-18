# F006 — Transformer AI detector

## Cierre local

| Campo | Resultado |
|---|---|
| Estado del run F006 | `PASS` |
| Fase | `F006_TRANSFORMER_AI_DETECTOR` |
| Modelo registrado | `EXPERIMENTAL_F006_MODEL` |
| Estado del modelo | `EXPERIMENTAL` |
| ACTIVE | `NONE` |
| Candidato V4 creado | No |
| Pesos disponibles localmente | No |
| Paso de investigación siguiente | `F006.1_SPANISH_GENERALIZATION` |

El informe oficial pasa 9 de 10 gates. Falla `D_spanish_strong`, por lo que F006 no es candidato V4 ni puede pasar a `ACTIVE`. La decisión no depende del macro-F1: el FPR humano en español del holdout es 14.23 %, por encima del límite de 8 %.

La rama de integración local se creó desde `exp/f006-transformer-ai-detector` en `f7edab7`. El bundle `f006_reports_bundle.tgz` se encontró y pasó la comprobación de integridad. Sus 17 archivos coinciden por SHA-256 con `training/reports/F006_TRAINING_REPORT.*` y `training/reports/f006/`; no se copiaron duplicados. El bundle original pesó 47,875 bytes y su SHA-256 fue `CE80DDD535A5DB623B21FA4A45AF2C00A36964FD0C683E792D3266F9540841AC`.

## Entrenamiento reportado

F006 partió de `CANDIDATE_MODEL_V3` y usó `TURNITING_DATASET_V2`. El entrenamiento aplicó hard negatives humanos seleccionados únicamente desde TRAIN, muestreo humano/máquina 40/60, proporción hard-negative 0.30, peso humano 1.5, peso español 3.0 y peso académico 1.5. Se usó weighted BCE y ablations sobre VALIDATION. La fracción nominal de párrafos fue 0.25 y la medida fue 0.2266. Stage B registró 440,335 ventanas.

| Datos y control | Cantidad / resultado |
|---|---:|
| Filas disponibles de entrenamiento | 2,883,110 |
| Pool de humanos difíciles | 32,665 |
| Validación | 30,490 documentos; 13,490 humanos |
| Holdout final bloqueado | 37,214 documentos; 15,514 humanos |
| Leakage exacto / near / group / parent-child | 0 / 0 / 0 / 0 |
| Ablations | 10 |

El registro de validación reporta FPR 0.0133 general, 0.0141 español, 0.0071 académico y 0.0053 para generadores no vistos. En el holdout cambió el resultado en español; el holdout se usó una vez y no para tuning.

### Hardware reportado

GPU: NVIDIA A100-SXM4-80GB; CPU: 12 cores lógicos; peak VRAM: 77.9 GB; utilización GPU media: 95.0 % y p50: 100 %.

Hay una discrepancia en RAM: la instrucción de cierre indica 167 GB y `F006_FULL_run.json` informa 179.37 GB. Se conservan ambos valores como conflicto de fuente; no se reconcilian por inferencia.

## Resultados F006

Valores del `F006_FINAL_HOLDOUT`, punto `BALANCED`:

| Métrica | Resultado |
|---|---:|
| Macro-F1 | 0.8314 |
| FPR humano general | 0.0447; IC 95 % [0.0415, 0.0480] |
| FPR humano español | 0.1423; IC 95 % [0.1287, 0.1571] |
| F1 español | 0.8102 |
| FPR humano académico | 0.0025; F1 0.8891 |
| Recall mixto | 0.6695 |
| F1 AI-edited | 0.8616 |
| F1 OOD / FPR humano OOD | 0.9308 / 0.0133 |
| F1 generador no visto / FPR humano | 0.8308 / 0.0692 |
| F1 dominio no visto / FPR humano | 0.8130 / 0.0180 |
| Recall adversarial | 0.7475 |
| Zero-width / homoglyph F1 | 0.8215 / 0.8194 |
| Span token F1 | 0.888 |

El F006 gate report registra `PASS` para A, B, C, E, F, G, H, I y J; registra `FAIL` para D. La política local de promoción también exige paragraph stability. El reporte muestra span token F1, pero no una medición separada de paragraph stability; esa evidencia queda como `NOT_EVALUATED`.

## Comparación congelada

Las cuatro filas usan los resultados BALANCED del mismo holdout; no se retunearon umbrales.

| Modelo | Macro-F1 | FPR general | FPR español | FPR académico | FPR generador no visto | Recall mixto | F1 AI-edited | F1 OOD | Zero-width / homoglyph |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `CANDIDATE_MODEL_V2` | 0.6203 | 0.0431 | 0.1161 | 0.0142 | 0.0400 | 0.1125 | 0.5092 | 0.6603 | 0.3310 / 0.4718 |
| `CANDIDATE_MODEL_V3` | 0.8299 | 0.0616 | 0.1827 | 0.0031 | 0.0892 | 0.6810 | 0.8524 | 0.9257 | 0.8407 / 0.8386 |
| `ENSEMBLE_V2_V3` | 0.6679 | 0.0369 | 0.1212 | 0.0009 | 0.0548 | 0.1845 | 0.5827 | 0.7278 | 0.3332 / 0.5737 |
| `EXPERIMENTAL_F006_MODEL` | 0.8314 | 0.0447 | 0.1423 | 0.0025 | 0.0692 | 0.6695 | 0.8616 | 0.9308 | 0.8215 / 0.8194 |

| Modelo | Evaluación frente a límites ACTIVE |
|---|---|
| V2 | Falla español; mixed, AI-edited y adversarial también son débiles en este holdout. |
| V3 | Falla FPR general y español. |
| Ensemble V2 + V3 | Falla español; mixed, AI-edited y robustez son limitados. |
| F006 | Cumple FPR general, académico y generador no visto; falla español. Su gate oficial es 9/10. |

Ninguno cumple todos los gates. Resultado: `ACTIVE = NONE`.

Como continuidad histórica, el benchmark V1 reporta para F006 macro-F1 0.874 y FPR 0.068; V3 FPR aproximado 0.106 y V2 FPR aproximado 0.033 en esa evaluación/rethreshold. Esos valores se conservan solo como benchmark histórico y no se usaron para tuning ni para la decisión ACTIVE.

## Registro, API y UI

`EXPERIMENTAL_F006_MODEL` se registra como `TRANSFORMER`, `EXPERIMENTAL`, `RESEARCH_ONLY`, con arquitectura base `microsoft/mdeberta-v3-base`, padre `CANDIDATE_MODEL_V3`, dataset `TURNITING_DATASET_V2` y estrategia `HARD_NEGATIVE_TARGETED_FINETUNE`. El registro conserva el estado experimental y los gates oficiales.

La importación local de metadata valida el manifiesto F006 y el gate report antes de crear la fila de modelo. La referencia externa se guarda como `GOOGLE_DRIVE`; la importación no descarga pesos. Los endpoints de modelos informan disponibilidad, pero omiten rutas de almacenamiento. `GET /api/models` devuelve modelos, resultados BALANCED, advertencias y estado de artefactos; el ensemble se representa como combinación de V2 y V3. La UI muestra F006 como experimental, sus fortalezas y la advertencia neutral sobre falsos positivos en español.

La importación creó solo el registro del modelo: `TURNITING_DATASET_V2` no existe en la base local, así que F006 conserva `datasetVersionId = null` y no se creó ni reconstruyó ningún dataset.

No existe una promoción automática. El servicio de promoción requiere una revisión explícita y que todos los gates numéricos y cualitativos estén en PASS. F006 queda bloqueado por `spanishHumanFpr` y por la paragraph stability no evaluada.

## Artefacto y seguridad

No existe una copia en `data/models/experimental-f006/`. El artefacto queda registrado como externo y no disponible localmente; la API de modelos informa pesos ausentes sin afectar health. No se descargó nada.

El manifiesto F006 contiene el SHA-256 reportado `640247c1f5829de903628a5219923de1d9a07baf263b1195749ee2d2b3f82f26`, pero no hay pesos locales con los cuales verificarlo. Por tanto, el hash local es `N/A`; el valor del manifiesto no se presenta como hash local validado. No se exponen rutas de Drive, rutas absolutas, tokens ni credenciales en las respuestas de API.

No se usaron documentos privados, `VALIDATION_CASE_001`, tesis del usuario ni reportes reales de Turnitin en la integración local.

## Siguiente investigación

`NEXT_RESEARCH_STEP = F006.1_SPANISH_GENERALIZATION`. El trabajo futuro debería ampliar humanos en español académico y no académico, cubrir países y estilos distintos, añadir hard humans en español, mejorar validation en español y evaluar calibración por idioma. MGTPD/EditLens queda condicionado a que exista acceso. Este entrenamiento no se inicia en este cierre.

F007 y la calibración frente a Turnitin quedan diferidos mientras `ACTIVE = NONE`.
