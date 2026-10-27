"""Explicit real-model synthetic smoke evaluation; no claim of lecture accuracy.

Run: .venv/bin/python evaluate_retakes.py --model ../../models/retakes-qwen3-8b
"""
import argparse
import json
import time
from pathlib import Path

from mlx_llm.retakes import PROMPT_VERSION, analyze

parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[2]
fixtures = json.loads((root / "tests/fixtures/retakes.json").read_text())
cache = {}
results = []
for fixture in fixtures:
    if not fixture.get("hypotheses"):
        continue
    records = [{"index": i, "text": word, "start": i * .35, "end": i * .35 + .25}
               for i, word in enumerate(fixture["words"].split())]
    start = time.monotonic()
    trace = []
    try:
        groups = analyze(records, fixture["hypotheses"], str(Path(args.model).resolve()), cache, trace)
        result = {"id": fixture["id"], "expectedPositive": fixture["positive"],
                  "groups": groups, "passed": bool(groups) == fixture["positive"]}
    except Exception as exc:
        result = {"id": fixture["id"], "error": str(exc), "passed": False}
    if fixture["id"] == "incomplete-last" and result.get("groups"):
        result["passed"] = result["passed"] and result["groups"][0]["attempts"][0]["complete"] and not result["groups"][0]["attempts"][-1]["complete"]
    result["raw"] = trace
    result["seconds"] = round(time.monotonic() - start, 3)
    results.append(result)
    print(json.dumps(result), flush=True)
    Path(args.output).write_text(json.dumps({"promptVersion": PROMPT_VERSION,
                                           "results": results}, indent=2) + "\n")

raise SystemExit(0 if all(r["passed"] for r in results) else 1)
