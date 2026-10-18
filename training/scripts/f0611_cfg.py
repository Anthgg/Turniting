"""Print 'human_share human_weight es_w mix token_weight' of a finished run (used by f0611_pipeline.sh)."""

import json
import sys

c = json.load(open(sys.argv[1]))["config"]
print(c["human_share"], c["human_weight"], c["es_w"], ",".join(str(x) for x in c["mix"]), c.get("token_weight") or 0.3)
