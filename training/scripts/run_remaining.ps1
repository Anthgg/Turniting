# Detached runner for the long CPU stages (survives a dropped remote session).
# Usage: powershell -File scripts\run_remaining.ps1 -GlobalId <id> -RefineId <id> [-SkipGlobal]
param([string]$GlobalId, [string]$RefineId, [switch]$SkipGlobal)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$py = Join-Path $root ".venv\Scripts\python.exe"
$log = Join-Path $root "datasets\cache\pipeline.log"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"

function Step($name, [string[]]$argv) {
    "$(Get-Date -Format s) START $name" | Add-Content $log
    & $py @argv *>> $log
    if ($LASTEXITCODE -ne 0) { "$(Get-Date -Format s) FAIL $name ($LASTEXITCODE)" | Add-Content $log; exit 1 }
    "$(Get-Date -Format s) OK $name" | Add-Content $log
}

if (-not $SkipGlobal) {
    Step "global" @("scripts/train_transformer.py", "--mode", "global", "--experiment-id", $GlobalId)
}
Step "refine" @("scripts/train_transformer.py", "--mode", "refine", "--experiment-id", $RefineId,
                "--init-from", "checkpoints/$GlobalId/best")
Step "pkg_global" @("scripts/calibrate.py", "--experiment", "checkpoints/$GlobalId", "--out", "models/transformer/global",
                    "--name", "GLOBAL_MULTILINGUAL_TRANSFORMER", "--link-weights")
Step "pkg_es" @("scripts/calibrate.py", "--experiment", "checkpoints/$RefineId", "--out", "models/transformer/spanish_academic",
                "--name", "SPANISH_ACADEMIC_TRANSFORMER", "--link-weights")
Step "pkg_cal" @("scripts/calibrate.py", "--experiment", "checkpoints/$RefineId", "--out", "models/calibrated/spanish_academic",
                 "--name", "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER", "--calibrate", "--link-weights")
$models = [ordered]@{
    "BEST_BASELINE" = "models/baseline/best"
    "GLOBAL_MULTILINGUAL_TRANSFORMER" = "models/transformer/global"
    "SPANISH_ACADEMIC_TRANSFORMER" = "models/transformer/spanish_academic"
    "CALIBRATED_SPANISH_ACADEMIC_TRANSFORMER" = "models/calibrated/spanish_academic"
}
foreach ($k in $models.Keys) {
    Step "val_$k" @("scripts/evaluate.py", "--model", $models[$k], "--name", "${k}__validation")
}
Step "select" @("scripts/select_model.py")
foreach ($k in $models.Keys) {
    Step "final_$k" @("scripts/evaluate.py", "--model", $models[$k], "--name", $k, "--final")
}
"$(Get-Date -Format s) PIPELINE_DONE" | Add-Content $log
