"""Retake-only JSON line service. Model stays loaded for one analysis process."""
import argparse
import json
import sys

from mlx_llm.retakes import analyze


def handle(line: str, model: str, cache: dict) -> str:
    request = None
    try:
        request = json.loads(line)
        if not isinstance(request, dict) or set(request) != {"id", "records", "hypotheses"}:
            raise ValueError("Invalid retake request")
        if not isinstance(request["id"], str) or not isinstance(request["records"], list):
            raise ValueError("Invalid retake request fields")
        groups = analyze(request["records"], request["hypotheses"], model, cache)
        return json.dumps({"id": request["id"], "groups": groups})
    except Exception as exc:
        return json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                           "error": str(exc)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    cache = {}
    while True:
        line = sys.stdin.buffer.readline(2_000_001)
        if not line:
            break
        if len(line) > 2_000_000 or not line.endswith(b"\n"):
            raise ValueError("Oversized or incomplete retake request")
        print(handle(line.decode("utf-8"), args.model, cache), flush=True)


if __name__ == "__main__":
    main()
