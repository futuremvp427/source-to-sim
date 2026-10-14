#!/usr/bin/env python3
"""Independent read-only checkpoint verifier, not a heartbeat based on job status."""
import argparse,json,time
from pathlib import Path
from collector import verify_checkpoint,summarize
ap=argparse.ArgumentParser();ap.add_argument("folder");args=ap.parse_args()
s=verify_checkpoint(Path(args.folder));out=summarize(s)
out["checkpoint_age_seconds"]=max(0,time.time()-s["last_cycle_at"])
out["publication_incident"]=out["checkpoint_age_seconds"]>1200 and not s["finished"]
print(json.dumps(out,indent=2))
if out["publication_incident"]:raise SystemExit(2)
