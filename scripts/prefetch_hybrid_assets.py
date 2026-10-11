"""Explicit asset download only; never called by offline inference."""
import argparse
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    from hybrid_v2.local_runtime import BGE, HF_CACHE, ROOT
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--model", default=BGE)
    p.add_argument("--revision")
    p.add_argument("--hf-cache-dir", type=Path, default=HF_CACHE)
    p.add_argument("--yolo", action="store_true")
    p.add_argument("--http", action="store_true", help="Use standard HTTP instead of Xet for Hugging Face downloads")
    p.add_argument("--yolo-output", type=Path, default=ROOT / "data/model-cache/yolo11n.pt")
    a = p.parse_args()
    if a.yolo:
        from urllib.request import urlretrieve
        path = a.yolo_output
        if path.exists():
            print("Already present:", path)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".pt.download")
        urlretrieve("https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt", tmp)
        tmp.replace(path)
        print("Downloaded:", path)
    else:
        if a.http:
            os.environ["HF_HUB_DISABLE_XET"] = "1"
        from huggingface_hub import snapshot_download
        print("Explicit model download:", a.model)
        print(snapshot_download(a.model, revision=a.revision, cache_dir=str(a.hf_cache_dir),
                                allow_patterns=["*.json", "*.txt", "*.model", "*.safetensors"]))


if __name__ == "__main__":
    main()
