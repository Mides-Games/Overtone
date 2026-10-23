"""Build a Graphify-compatible status graph from the curated roadmap index."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "project-status.json"
OUTPUT = ROOT / "graphify-out" / "project-status" / "graphify-out" / "graph.json"


def main():
    status = json.loads(SOURCE.read_text(encoding="utf-8-sig"))
    nodes = status["nodes"]
    ids = [node["id"] for node in nodes]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate node id in docs/project-status.json")
    known = set(ids)
    node_by_id = {node["id"]: node for node in nodes}
    links = []
    for source, target, relation in status["links"]:
        if source not in known or target not in known:
            raise SystemExit(f"unknown graph endpoint: {source} -> {target}")
        links.append({"source": source, "target": target, "relation": relation,
                      "_origin": "curated-roadmap", "confidence": "EXTRACTED",
                      "confidence_score": 1.0, "context": "documented roadmap relation",
                      "source_file": node_by_id[source]["source"],
                      "source_location": f"L{node_by_id[source]['line']}"})
    graph = {"directed": True, "multigraph": True,
             "graph": {"name": "Overtone project status",
                       "snapshot_date": status["snapshot_date"],
                       "source_policy": status["source_policy"]},
             "nodes": [{**node, "file_type": "project_status",
                        "source_file": node["source"],
                        "source_location": f"L{node['line']}",
                        "norm_label": node["label"].lower()} for node in nodes],
             "links": links, "hyperedges": []}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + chr(10), encoding="utf-8")
    print(f"wrote {len(nodes)} nodes and {len(links)} relationships to {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
