#!/usr/bin/env python3
"""F006.1.3 closeout; reads small manifests only, never holdout data rows."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from typing import Any

BASE_BRANCH = "exp/f006-1-1-detector-hardening"
BASE_COMMIT = "0ad01f5fb75b48cdd1cce3a9b0084511253a69f1"
RESEARCH_BRANCH = "exp/f006-1-3-unified-ensemble"
COMPONENTS = {
    "V2": ("TURNITING_AI_V1", "workdir/models/gpu/calibrated_spanish_academic/model_manifest.json"),
    "V3": ("TURNITING_RESEARCH_V3_SPANISH_ACADEMIC", "v3/models/spanish_academic/model_manifest.json"),
    "F006.1": ("EXPERIMENTAL_F006_1_MODEL", "f006_1/models/experimental_f006_1/model_manifest.json"),
    "F006.1.1": ("EXPERIMENTAL_F006_1_1_MODEL", "f006_1_1/models/experimental_f006_1_1/model_manifest.json"),
}
IDENTITY_FIELDS = ("modelVersion", "displayName", "variant", "experimentId", "modelRevision", "architecture", "datasetVersion", "gitCommit", "status", "active", "calibrated", "commercialEligibility", "notTurnitin")
NUMERIC_KEYS = {"holdout_train","validation_holdout","validation_train","holdout_ever_evaluated","holdout_f006_holdout","holdout_prior_holdouts","spanish_holdout_train_extra","spanish_validation_train_extra","v2_train_eval","eval_train_new","spanish_eval_f006_1_train_extra","cowsl2h_students_holdout_train","cowsl2h_students_validation_holdout","cowsl2h_students_validation_train"}

def read_json(p: Path) -> dict[str, Any]: return json.loads(p.read_text(encoding="utf-8"))
def sha256(p: Path) -> str: return hashlib.sha256(p.read_bytes()).hexdigest()
def numeric_findings(v: Any) -> dict[str, int | float]:
    if not isinstance(v, dict): return {}
    return {str(k): n for k,n in v.items() if str(k) in NUMERIC_KEYS and isinstance(n,(int,float)) and not isinstance(n,bool)}
def prior_leakage(p: Path) -> dict[str, Any]:
    if not p.is_file(): return {"manifest_exists":False,"result":"NOT_AVAILABLE"}
    raw=read_json(p); sections={}
    for s in ("exact","near_duplicate","group","lineage","parent_child","participant"):
        v=raw.get(s,{}) if isinstance(raw.get(s),dict) else {}
        counts=numeric_findings(v)
        sections[s]={"numeric_findings":counts,"unreported_detail_entries":len(v)-len(counts)}
    return {"manifest_exists":True,"result":raw.get("result","UNKNOWN"),"sections":sections,"manifest_sha256":sha256(p)}

def main() -> None:
    ap=argparse.ArgumentParser()
    ap.add_argument("--drive-root",type=Path,default=Path("/content/drive/MyDrive/turniting"))
    ap.add_argument("--repo-root",type=Path,default=Path(__file__).resolve().parents[2])
    a=ap.parse_args(); drive=a.drive_root; repo=a.repo_root
    report_dir=repo/"training/reports"; out_root=drive/"f006_1_3"
    names=["F006_1_3_UNIFIED_ENSEMBLE.md","F006_1_3_UNIFIED_ENSEMBLE.json","F006_1_3_DATASET_MANIFEST.json","F006_1_3_LEAKAGE_AUDIT.json","F006_1_3_COMPONENT_PREDICTIONS_SUMMARY.json","F006_1_3_ABLATIONS.json","F006_1_3_DISAGREEMENT_ANALYSIS.json","F006_1_3_UNIFIED_MODEL_LOCK.json","F006_1_3_FINAL_HOLDOUT.json"]
    for n in names:
        if (report_dir/n).exists() or (out_root/"reports"/n).exists(): raise FileExistsError(f"Refusing to overwrite {n}")
    if Path(__file__).resolve() != (repo/"training/scripts/f006_1_3_closeout.py").resolve(): raise RuntimeError("Unexpected repository root")
    components={}
    for key,(expected,rel) in COMPONENTS.items():
        p=drive/rel
        if not p.is_file():
            components[key]={"model_id":expected,"manifest_exists":False,"manifest_sha256":None,"identity":{},"weight_sha256":None}
            continue
        raw=read_json(p)
        components[key]={"model_id":raw.get("modelVersion",expected),"manifest_path":str(p),"manifest_exists":True,"manifest_sha256":sha256(p),"identity":{k:raw[k] for k in IDENTITY_FIELDS if k in raw and isinstance(raw[k],(str,int,float,bool,type(None)))},"weight_sha256":None,"weight_hash_status":"PROVENANCE_VERIFIED_NOT_RESEARCH_HASH_LOCKED" if key=="F006.1.1" else "NOT_COMPUTED_NO_FUSION_LOCK"}
    mp={"f006_1_new_sources":drive/"f006_1/manifests/new_spanish_sources.json","f006_1_train":drive/"f006_1/manifests/f006_1_train_extra.json","f006_1_validation":drive/"f006_1/manifests/f006_1_validation.json","f006_1_1_dataset":drive/"f006_1_1/manifests/F006_1_1_DATASET_MANIFEST.json","f006_1_1_train":drive/"f006_1_1/manifests/f006_1_1_train_extra.json","f006_1_1_validation":drive/"f006_1_1/manifests/f006_1_1_validation.json"}
    m={k:read_json(p) if p.is_file() else {} for k,p in mp.items()}
    f61src=m["f006_1_new_sources"]; f61train=m["f006_1_train"]; f61val=m["f006_1_validation"]
    f611ds=m["f006_1_1_dataset"]; f611train=m["f006_1_1_train"]; f611val=m["f006_1_1_validation"]
    dedup=f611ds.get("dedup",{}) if isinstance(f611ds.get("dedup"),dict) else {}
    source_evidence={"F006.1":{"new_source_rows_after_dedup":f61src.get("rows_final"),"new_source_near_duplicates_removed":f61src.get("near_dup_removed"),"train_extra_rows":f61train.get("rows")},"F006.1.1":{"train_extra_rows":f611train.get("rows"),"new_rows_in_train_extra":f611train.get("f006_1_1_new"),"dedup_before":dedup.get("rows_before"),"dedup_after":dedup.get("rows_after"),"exact_vs_v2_removed":dedup.get("exact_vs_v2_removed"),"near_vs_reference_removed":dedup.get("near_vs_reference_removed")}}
    validations={"F006.1":{"groups":f61val.get("groups"),"leakage_result":(f61val.get("leakage") or {}).get("result")},"F006.1.1":{"groups":f611val.get("groups"),"leakage_result":(f611val.get("leakage") or {}).get("result")}}
    legacy={"F006.1":prior_leakage(drive/"f006_1/manifests/f006_1_leakage_FAIL.json"),"F006.1.1":prior_leakage(drive/"f006_1_1/manifests/f006_1_1_leakage_FAIL.json")}
    hashes={k:sha256(p) for k,p in mp.items() if p.is_file()}
    generated=datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    reason=("No F006.1.3 pool or sealed META_FINAL_HOLDOUT was supplied. Existing candidates are component training/validation provenance or historical data. Prior cross-boundary leakage reports contain nonzero near-duplicate findings. No group, lineage, participant, prompt, or parent-child audit has been run for new F006.1.3 groups.")
    dataset={"schema_version":1,"phase":"F006_1_3_UNIFIED_ENSEMBLE_CALIBRATION","generated_at_utc":generated,"pool_name":"F006_1_3_FUSION_POOL","pool_status":"NOT_CREATED_NO_ELIGIBLE_GROUPS_CERTIFIED","fusion_pool_size_eligible":0,"meta_train_size":0,"meta_calibration_size":0,"meta_validation_size":0,"meta_final_holdout_size":0,"final_holdout_independence":"INSUFFICIENT","source_evidence":source_evidence,"component_validation_evidence_not_reused":validations,"input_manifest_sha256":hashes,"exclusion_reason":reason,"lineage_fields_required_for_resumption":["document_hash","group_id","parent_id","source_id","participant_id","generator_family","prompt_id","split"],"historical_final_holdout_files_read":False,"parquet_rows_read":False}
    leakage={"schema_version":1,"meta_final_holdout_exists":False,"meta_final_holdout_leakage_status":"NOT_EVALUATED_NO_META_FINAL_HOLDOUT","exact":None,"near":None,"group":None,"lineage":None,"zero_leakage_gate":"NOT_EVALUATED","historical_component_audits":legacy,"interpretation":"Prior validation manifests report PASS, but this does not certify F006.1.3 final-holdout independence."}
    predictions={"schema_version":1,"status":"NOT_GENERATED_NO_ELIGIBLE_POOL","predictions_generated":0,"cache_path":None,"components":{k:{"model_id":v.get("model_id"),"scores_generated":0,"inference_run":False,"manifest_sha256":v.get("manifest_sha256")} for k,v in components.items()},"existing_v2_v3_ensemble_logic_reproduced":False,"reason":reason}
    planned=["A1_existing_ensemble_only","A2_F006_1_only","A3_F006_1_1_only","A4_simple_3_score_mean","A5_constrained_3_score_weighted","B1_simple_4_score_mean","B2_constrained_4_score_weighted","B3_logistic_4","B4_logistic_4_plus_language","B5_language_specific_fusion"]
    ablations={"schema_version":1,"status":"NOT_RUN_INDEPENDENT_META_SPLITS_UNAVAILABLE","planned_configuration_count":len(planned),"run_count":0,"configurations":[{"id":x,"status":"NOT_RUN","validation_metrics":None,"coefficients":None} for x in planned],"selection":None,"reason":reason}
    disagreement={"schema_version":1,"status":"NOT_RUN_NO_COMPONENT_PREDICTIONS","cases":["ALL_AGREE_HUMAN","ALL_AGREE_AI","F0061_AI_F00611_HUMAN","F0061_HUMAN_F00611_AI","V2_V3_DISAGREE"],"counts":None,"error_rates":None,"specialist_analysis":None}
    lock={"schema_version":1,"lock_status":"NOT_LOCKED","model_name":"TURNITING_UNIFIED_EXPERIMENTAL_V1","model_status":"EXPERIMENTAL","candidate":False,"active_model":"NONE","component_ids_and_manifest_hashes":components,"component_weight_hashes":{"V2":None,"V3":None,"F006.1":None,"F006.1.1":None},"f006_1_1_weight_integrity":"PROVENANCE_VERIFIED_NOT_RESEARCH_HASH_LOCKED","fusion_family":None,"features":None,"coefficients":None,"calibrator":None,"threshold":None,"language_routing":None,"dataset_manifest_hash":None,"split_hashes":None,"code_commit":None,"artifact_path":None,"reason_not_locked":reason,"component_weights_changed":False}
    final={"schema_version":1,"status":"NOT_EVALUATED","independence":"INSUFFICIENT","rows":0,"read_or_scored":False,"final_holdout_tuning":False,"leakage":{"exact":None,"near":None,"group":None,"lineage":None},"metrics":None,"confidence_intervals_95":None,"component_same_holdout_comparison":None,"reason":reason}
    gates={k:"NOT_EVALUATED" for k in ("overall_human_fpr_le_0.05","spanish_human_fpr_le_0.05","academic_human_fpr_le_0.05","unseen_generator_fpr_le_0.10","mixed_recall_ge_0.64","ai_edited_f1_ge_0.90","ood_f1_ge_0.90","macro_f1_ge_0.89","leakage_zero","ece_le_0.03")}
    gates["final_holdout_untouched_until_lock"]="PASS_NO_FINAL_HOLDOUT_READ"
    report={"schema_version":1,"status":"EXPERIMENTAL","phase":"F006_1_3_UNIFIED_ENSEMBLE_CALIBRATION","generated_at_utc":generated,"git":{"branch":RESEARCH_BRANCH,"base_branch":BASE_BRANCH,"base_commit":BASE_COMMIT},"components":components,"fusion_pool_size":0,"meta_train_size":0,"meta_calibration_size":0,"meta_validation_size":0,"meta_final_holdout_size":0,"final_holdout_independence":"INSUFFICIENT","leakage_exact":None,"leakage_near":None,"leakage_group":None,"leakage_lineage":None,"best_fusion_family":None,"best_features":None,"best_weights":None,"best_coefficients":None,"calibrator":None,"unified_threshold":None,"spanish_specific_calibration":None,"validation_metrics":None,"final_metrics":None,"same_holdout_component_comparison":None,"primary_gates":gates,"gates_passed":[],"failed_or_unmet_gates":["independent META_FINAL_HOLDOUT unavailable","fusion and calibration not fitted"],"model_name":"TURNITING_UNIFIED_EXPERIMENTAL_V1","model_status":"EXPERIMENTAL","candidate":False,"model_path":None,"active_model":"NONE","span_model_used":False,"similarity_model_used":False,"component_weights_changed":False,"transformer_training":False,"meta_model_training":False,"private_document_used":False,"turnitin_data_used":False,"model_weights_in_git":False,"final_holdout_tuning":False,"fusion_artifact_hash":None,"latency":{"sequential":None,"parallel":None,"fusion_overhead":None,"status":"NOT_MEASURED"},"resource_observation":{"gpu":"NVIDIA RTX PRO 6000 Blackwell Server Edition","peak_ram":None,"peak_vram":None,"status":"NO_MODEL_INFERENCE_RUN"},"findings":["No F006.1.3 pool or sealed final holdout is available for this run.","Existing component validation manifests report PASS but are not a new F006.1.3 final holdout.","Prior component cross-boundary reports show nonzero near-duplicate findings."],"warnings":["Legacy leakage_FAIL manifests remain FAIL; see leakage audit.","F006.1.1 weights have no research hash lock."],"limitations":["No component inference, meta-training, calibration, threshold selection, ablation, disagreement analysis, latency benchmark, or final evaluation was run.","No exact/near/group/lineage leakage rates can be claimed for a nonexistent META_FINAL_HOLDOUT."],"next_step":"Collect a new licensed corpus with disjoint document/group/lineage/source/participant/generator/prompt/parent-child coverage; seal group-safe meta splits before tuning.","output_contract":{"unifiedScore":"number after a future locked model exists","unifiedThreshold":None,"flagged":"boolean after a future locked model exists","fusionVersion":"TURNITING_UNIFIED_EXPERIMENTAL_V1","components":[]}}
    artifacts={"F006_1_3_UNIFIED_ENSEMBLE.json":report,"F006_1_3_DATASET_MANIFEST.json":dataset,"F006_1_3_LEAKAGE_AUDIT.json":leakage,"F006_1_3_COMPONENT_PREDICTIONS_SUMMARY.json":predictions,"F006_1_3_ABLATIONS.json":ablations,"F006_1_3_DISAGREEMENT_ANALYSIS.json":disagreement,"F006_1_3_UNIFIED_MODEL_LOCK.json":lock,"F006_1_3_FINAL_HOLDOUT.json":final}
    rows="\n".join(f"| {k} | {v.get('model_id')} | {v.get('manifest_sha256')} | No |" for k,v in components.items())
    markdown=("# F006.1.3 — Unified Ensemble Calibration\n\n"+"**Status:** EXPERIMENTAL · **Candidate:** NO · **Active model:** NONE\n\n"+"**Final holdout independence:** INSUFFICIENT\n\n"+f"**Research branch:** {RESEARCH_BRANCH} from {BASE_COMMIT}\n\n"+"## Decision\n\n"+"The fusion pool has 0 certified eligible examples and all four meta splits have size 0. Drive contains component training and validation artifacts, but no sealed, independently documented F006.1.3 pool or META_FINAL_HOLDOUT. Existing validation manifests do not establish a new untouched final holdout.\n\n"+"Prior cross-boundary leakage reports remain FAIL: F006.1 records one near-duplicate in Spanish validation versus train-extra and one in Spanish holdout versus train-extra; F006.1.1 records two near-duplicates in eval versus new train data. These are legacy findings, not rates against a new F006.1.3 final holdout.\n\n"+"No transformer inference/training, meta-model fitting, calibration, threshold selection, ablation, disagreement analysis, or final-holdout evaluation was performed. No component scores, fusion weights, coefficients, threshold, or model artifact are claimed.\n\n"+"## Component manifests\n\n| Component | ID | Manifest SHA-256 | Weights changed |\n|---|---|---|---|\n"+rows+"\n\nF006.1.1 weight integrity: PROVENANCE_VERIFIED_NOT_RESEARCH_HASH_LOCKED. Component manifest hashes are metadata hashes, not weight hashes.\n\n"+"## Evaluation status\n\nAll metric gates are NOT_EVALUATED because no eligible meta splits or final holdout exist. The no-read gate passed for this run. Leakage counts against a new META_FINAL_HOLDOUT are null, not zero.\n\n| Split | Size |\n|---|---:|\n| FUSION_POOL eligible | 0 |\n| META_TRAIN | 0 |\n| META_CALIBRATION | 0 |\n| META_VALIDATION | 0 |\n| META_FINAL_HOLDOUT | 0 |\n\n"+"## Resume requirement\n\nObtain a new labeled and licensed corpus with document, group, lineage, source, participant, generator-family, prompt, and parent-child identifiers. Audit against every component training manifest, freeze group-safe splits, lock fusion and calibration using validation only, then score the sealed final holdout exactly once.\n\n"+"No F008 similarity, no span model, no component weight changes, and no product/backend/frontend/F009 edits.\n\n"+f"Generated at {generated}.\n")
    report_dir.mkdir(parents=True,exist_ok=True)
    for rel in ("datasets","predictions","manifests","runs","models","reports"): (out_root/rel).mkdir(parents=True,exist_ok=True)
    for name,obj in artifacts.items():
        content=json.dumps(obj,ensure_ascii=False,indent=2,sort_keys=True)+chr(10)
        (report_dir/name).write_text(content,encoding="utf-8")
        (out_root/"reports"/name).write_text(content,encoding="utf-8")
    (report_dir/"F006_1_3_UNIFIED_ENSEMBLE.md").write_text(markdown,encoding="utf-8")
    (out_root/"reports/F006_1_3_UNIFIED_ENSEMBLE.md").write_text(markdown,encoding="utf-8")
    for name in ("F006_1_3_DATASET_MANIFEST.json","F006_1_3_LEAKAGE_AUDIT.json","F006_1_3_UNIFIED_MODEL_LOCK.json"):
        (out_root/"manifests"/name).write_text(json.dumps(artifacts[name],ensure_ascii=False,indent=2,sort_keys=True)+chr(10),encoding="utf-8")
    print(json.dumps({"status":"EXPERIMENTAL","candidate":False,"eligible_pool_size":0,"meta_splits":{"train":0,"calibration":0,"validation":0,"final_holdout":0},"reports_written":sorted([*artifacts,"F006_1_3_UNIFIED_ENSEMBLE.md"]),"drive_root":str(out_root),"repo_root":str(repo)},indent=2))
if __name__=="__main__": main()
