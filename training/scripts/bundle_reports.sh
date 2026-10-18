#!/usr/bin/env bash
# Collect the small JSON / MD reports and manifests of F006.1.1, F008 and F006.1.2 into one tgz on Drive.
# No weights, datasets or checkpoints (only *.json / *.md under 5 MB).
set -euo pipefail
T=/content/drive/MyDrive/turniting
OUT=/content/bundle
rm -rf $OUT && mkdir -p $OUT
copy() {  # src_dir dst_subdir
  [ -d "$1" ] || return 0
  mkdir -p "$OUT/$2"
  find "$1" -maxdepth 1 -type f \( -name '*.json' -o -name '*.md' \) -size -5M -exec cp {} "$OUT/$2/" \;
}
copy $T/f006_1_1/reports            f006_1_1/reports
copy $T/f006_1_1/manifests          f006_1_1/manifests
copy $T/f008/reports                f008/reports
copy $T/f008/manifests              f008/manifests
copy /content/repo_b/training/reports/f008 f008/repo_reports
copy $T/f006_1_2/reports            f006_1_2/reports
copy $T/f006_1_2/manifests          f006_1_2/manifests
copy /content/repo_c/training/reports/f006_1_2 f006_1_2/repo_reports
for r in $T/f006_1_2/runs/*/result.json; do
  [ -f "$r" ] || continue
  n=$(basename "$(dirname "$r")"); mkdir -p $OUT/f006_1_2/runs; cp "$r" "$OUT/f006_1_2/runs/$n.json"
done
cp $T/f006_1_2/runs/PARENT_*_validation.json $OUT/f006_1_2/runs/ 2>/dev/null || true
for l in decision stage_a full lock final; do [ -f $T/f006_1_2/logs/$l.done ] && cp $T/f006_1_2/logs/$l.done $OUT/f006_1_2/runs/$l.done.json; done
# never ship secrets: fail loudly if anything token-like slipped in
if grep -rIlE '(hf_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_)' $OUT; then echo "ABORT: token-like string found"; exit 1; fi
tar -czf $T/parallel_reports_bundle.tgz -C $OUT .
ls -la $T/parallel_reports_bundle.tgz
find $OUT -type f | wc -l
