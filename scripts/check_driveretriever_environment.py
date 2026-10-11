import argparse
import importlib.metadata
import json
import shutil
from pathlib import Path

from src.indexing.config import load_pipeline_config
from src.indexing.models.driveretriever_adapter import file_checksum


def main():
    parser = argparse.ArgumentParser(description="Read-only DriveRetriever environment check")
    parser.add_argument("--config", default="configs/indexing/local.yaml")
    parser.add_argument("--output", default="data/reports/driveretriever-environment.json")
    args = parser.parse_args()
    config = load_pipeline_config(args.config)
    versions = {}
    for package in ("av", "torch", "torchvision", "transformers", "temporalio", "psycopg", "qdrant-client", "minio"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    checkpoint = Path(config.driveretriever.checkpoint)
    runtime = {"configured_device": config.driveretriever.device,
               "configured_precision": config.driveretriever.precision,
               "cuda_available": False, "cuda_runtime": None, "gpu_name": None}
    try:
        import torch
        runtime["cuda_available"] = torch.cuda.is_available()
        runtime["cuda_runtime"] = torch.version.cuda
        device = torch.device(config.driveretriever.device)
        if runtime["cuda_available"] and device.type == "cuda":
            runtime["gpu_name"] = torch.cuda.get_device_name(device)
        runtime["device_ready"] = device.type == "cpu" or (
            device.type == "cuda" and runtime["gpu_name"] is not None
        )
    except (ImportError, RuntimeError, ValueError, AssertionError) as exc:
        runtime["device_ready"] = False
        runtime["error"] = str(exc)
    report = {"packages": versions, "ffmpeg_available": shutil.which("ffmpeg") is not None,
              "runtime": runtime,
              "ffprobe_available": shutil.which("ffprobe") is not None,
              "checkpoint_available": checkpoint.is_file(),
              "checkpoint_sha256": file_checksum(checkpoint) if checkpoint.is_file() else None,
              "dependency_lock_sha256": file_checksum("requirements.lock") if Path("requirements.lock").is_file() else None,
              "quality_status": "not_evaluated"}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if (all(versions.values()) and report["ffprobe_available"]
                 and report["checkpoint_available"] and runtime["device_ready"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
