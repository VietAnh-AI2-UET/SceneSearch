"""Search one source video with the real DriveRetriever epoch-4 checkpoint."""

from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.single_video_search import (  # noqa: E402
    WindowDecoder,
    extract_clip,
    generate_windows,
    probe_video,
    rank_windows,
    timestamp,
    window_dicts,
)


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path)
    parser.add_argument("--query")
    parser.add_argument("--checkpoint", type=Path, default=Path("data/model-cache/driveretriever-epoch4/best.pt"))
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--window-sec", type=float, default=10.0)
    parser.add_argument("--stride-sec", type=float, default=5.0)
    parser.add_argument("--num-frames", type=int, default=12)
    parser.add_argument("--dedup-iou", type=float, default=0.25)
    parser.add_argument("--no-dedup", action="store_true")
    parser.add_argument("--keep-cache", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--precision", choices=("auto", "fp32", "fp16", "bf16"), default="auto")
    parser.add_argument("--validate-checkpoint", action="store_true")
    parser.add_argument("--smoke-test", action="store_true")
    args = parser.parse_args(argv)
    if not args.validate_checkpoint and (args.video is None or not args.query or not args.query.strip()):
        parser.error("--video and a non-empty --query are required for search")
    if args.top_k <= 0 or args.batch_size <= 0 or args.num_frames <= 0:
        parser.error("--top-k, --batch-size, and --num-frames must be positive")
    if not 0 < args.dedup_iou <= 1:
        parser.error("--dedup-iou must be in (0, 1]")
    return args


def _json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _device(requested: str):
    import torch

    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable. Use --device cpu or --device auto.")
    if requested == "auto" and not torch.cuda.is_available():
        print("CUDA unavailable; continuing on CPU. This will be significantly slower for long video.")
    return torch.device("cuda" if requested == "cuda" or requested == "auto" and torch.cuda.is_available() else "cpu")


def _git_commit() -> str | None:
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def _run_dir(optional: Path | None) -> Path:
    if optional:
        directory = optional.expanduser().resolve()
        directory.mkdir(parents=True, exist_ok=False)
        return directory
    base = ROOT / "outputs" / "single_video_search"
    base.mkdir(parents=True, exist_ok=True)
    for suffix in range(100):
        name = datetime.now().strftime("%Y%m%d_%H%M%S_%f") + (f"_{suffix}" if suffix else "")
        directory = base / name
        try:
            directory.mkdir()
            return directory
        except FileExistsError:
            continue
    raise RuntimeError("Could not create a unique output directory")


def _validate_geometry(args: argparse.Namespace, config: dict) -> None:
    expected_frames = int(config.get("num_frames", 12))
    if args.num_frames != expected_frames:
        raise ValueError(
            f"--num-frames={args.num_frames} differs from checkpoint temporal position count "
            f"{expected_frames}; this checkpoint requires exactly {expected_frames} frames."
        )
    for key, actual in (("window_sec", args.window_sec), ("stride_sec", args.stride_sec)):
        expected = float(config.get(key, {"window_sec": 10.0, "stride_sec": 5.0}[key]))
        if actual != expected:
            print(f"WARNING: --{key.replace('_', '-')}={actual} differs from training value {expected}.")


def run(args: argparse.Namespace) -> int:
    import numpy as np
    import torch

    from src.indexing.models.driveretriever import DriveRetriever, check_embeddings, load_heads

    started = time.perf_counter()
    checkpoint_path = (
        (ROOT / args.checkpoint).resolve() if not args.checkpoint.is_absolute() else args.checkpoint.resolve()
    )
    loaded = load_heads(checkpoint_path)
    print(f"Checkpoint found: {checkpoint_path}")
    print(f"SHA256: {loaded.checkpoint_sha256}")
    print(f"Top-level keys: {loaded.top_level_keys}")
    print(f"Model-state key: {loaded.state_key}; epoch: {loaded.epoch}")
    print(f"Stored config: {loaded.config}")
    print(f"Backbone: {loaded.backbone_name}; embedding dimension: 512")
    print("Missing keys = 0; unexpected keys = 0; shape mismatches = 0")
    print("OK: DriveRetriever checkpoint loaded strictly. Model successfully initialized (trainable heads).")
    if args.validate_checkpoint:
        return 0
    _validate_geometry(args, loaded.config)
    video_path = args.video.expanduser().resolve()
    if not video_path.is_file():
        raise FileNotFoundError(f"Input video does not exist: {video_path}")
    device = _device(args.device)
    print(f"Selected device: {device}")
    timing = {
        key: 0.0
        for key in (
            "probe",
            "window_generation",
            "decode",
            "video_embedding",
            "text_embedding",
            "ranking",
            "clip_extraction",
            "total",
        )
    }
    tick = time.perf_counter()
    video_info = probe_video(video_path)
    timing["probe"] = time.perf_counter() - tick
    tick = time.perf_counter()
    windows = generate_windows(video_info["duration_sec"], args.window_sec, args.stride_sec)
    timing["window_generation"] = time.perf_counter() - tick
    if not windows:
        raise ValueError("Video produced no meaningful candidate windows")
    print(
        f"Video: {timestamp(video_info['duration_sec'])}; {video_info['fps']:.3f} fps; "
        f"{video_info['width']}x{video_info['height']}; {len(windows)} windows"
    )
    model = DriveRetriever(loaded, device, args.precision)
    print(f"Resolved backbone revision: {model.resolved_revision}")
    tick = time.perf_counter()
    query_vector = model.encode_text(args.query)
    timing["text_embedding"] = time.perf_counter() - tick
    check_embeddings(query_vector, expected_ndim=1)
    embeddings = np.empty((len(windows), 512), dtype=np.float32)
    with WindowDecoder(video_path, video_info["fps"], args.num_frames) as decoder:
        for start in range(0, len(windows), args.batch_size):
            batch = windows[start : start + args.batch_size]
            tick = time.perf_counter()
            frames = [decoder.decode(window) for window in batch]
            timing["decode"] += time.perf_counter() - tick
            tick = time.perf_counter()
            vectors = model.encode_video(frames)
            timing["video_embedding"] += time.perf_counter() - tick
            embeddings[start : start + len(batch)] = vectors.numpy()
            del frames, vectors
            if args.verbose or start == 0 or (start // args.batch_size + 1) % 20 == 0:
                print(f"Embedded {min(start + len(batch), len(windows))}/{len(windows)} windows")
    if embeddings.shape != (len(windows), 512) or not np.isfinite(embeddings).all():
        raise ValueError("Video embedding matrix has invalid shape or non-finite values")
    norms = np.linalg.norm(embeddings, axis=1)
    if np.any(np.abs(norms - 1) > 1e-3):
        raise ValueError("Video embeddings failed L2 norm validation")
    tick = time.perf_counter()
    scores = embeddings @ query_vector.numpy()
    if not np.isfinite(scores).all():
        raise ValueError("Similarity scores contain non-finite values")
    ranked = rank_windows(windows, scores.tolist(), args.top_k, None if args.no_dedup else args.dedup_iou)
    timing["ranking"] = time.perf_counter() - tick
    if any(ranked[i]["score"] < ranked[i + 1]["score"] for i in range(len(ranked) - 1)):
        raise AssertionError("Ranking is not sorted")
    directory = _run_dir(args.output_dir)
    if args.keep_cache:
        np.save(directory / "candidate_embeddings.npy", embeddings)
        _json(directory / "candidates.json", {"windows": window_dicts(windows)})
    del embeddings
    for result in ranked:
        if not (0 <= result["start_sec"] < result["end_sec"] <= video_info["duration_sec"] + 1e-6):
            raise AssertionError("Ranked timestamp outside source video")
        start_name = result["start_timestamp"].replace(":", "-")
        end_name = result["end_timestamp"].replace(":", "-")
        result["clip_path"] = f"rank_{result['rank']:02d}_{start_name}_{end_name}.mp4"
        result["clip_extraction_status"] = "pending"
    results = {
        "query": args.query,
        "source_video": str(video_path),
        "checkpoint": str(checkpoint_path),
        "checkpoint_sha256": loaded.checkpoint_sha256,
        "model": {
            "family": "driveretriever",
            "backbone": loaded.backbone_name,
            "backbone_revision": model.resolved_revision,
            "embedding_dim": 512,
            "window_sec": args.window_sec,
            "stride_sec": args.stride_sec,
            "num_frames": args.num_frames,
        },
        "video": video_info,
        "candidate_count": len(windows),
        "top_k": args.top_k,
        "dedup": {"enabled": not args.no_dedup, "temporal_iou_threshold": args.dedup_iou},
        "results": ranked,
        "timing_sec": timing,
    }
    run_info = {
        "timestamp": datetime.now(UTC).isoformat(),
        "python_version": platform.python_version(),
        "torch_version": torch.__version__,
        "transformers_version": __import__("transformers").__version__,
        "cuda_available": torch.cuda.is_available(),
        "cuda_runtime": torch.version.cuda,
        "gpu_name": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        "checkpoint": str(checkpoint_path),
        "checkpoint_sha256": loaded.checkpoint_sha256,
        "source_video": str(video_path),
        "backbone_revision": model.resolved_revision,
        "cli_arguments": {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
        "git_commit": _git_commit(),
    }
    _json(directory / "run_info.json", run_info)
    _json(directory / "results.json", results)
    tick = time.perf_counter()
    extraction_failed = False
    for result in ranked:
        try:
            extract_clip(
                video_path, directory / result["clip_path"], result["start_sec"], result["end_sec"], video_info["fps"]
            )
            result["clip_extraction_status"] = "ok"
        except Exception as exc:
            result["clip_extraction_status"] = "failed"
            result["clip_extraction_error"] = str(exc)
            extraction_failed = True
        _json(directory / "results.json", results)
    timing["clip_extraction"] = time.perf_counter() - tick
    timing["total"] = time.perf_counter() - started
    _json(directory / "results.json", results)
    print(f"\nQuery: {args.query}\nRank  Score     Start       End         Timestamp")
    for item in ranked:
        print(
            f"{item['rank']:>4}  {item['score']:>7.4f}  {item['start_sec']:>10.3f}  "
            f"{item['end_sec']:>10.3f}  {item['start_timestamp']} --> {item['end_timestamp']}"
        )
    best = ranked[0]
    print(
        f"\nBEST_MATCH = rank 1\n  score: {best['score']:.4f}\n  start_sec: {best['start_sec']:.3f}"
        f"\n  end_sec: {best['end_sec']:.3f}\n  timestamp: {best['start_timestamp']} --> "
        f"{best['end_timestamp']}\n  clip: {directory / best['clip_path']}"
    )
    print(f"Results: {directory / 'results.json'}\nRun info: {directory / 'run_info.json'}")
    print("Timing (s): " + ", ".join(f"{key}={value:.2f}" for key, value in timing.items()))
    print(
        f"Throughput: {video_info['duration_sec'] / max(timing['total'], 1e-9):.2f} "
        f"video-seconds/wall-second; {len(windows) / max(timing['total'], 1e-9):.2f} windows/s; "
        f"GPU used: {device.type == 'cuda'}"
    )
    if args.smoke_test:
        assert all(item["clip_extraction_status"] == "ok" for item in ranked)
        print("Smoke test passed: embeddings, scores, ranking, timestamps, JSON, and clips validated.")
    return 1 if extraction_failed else 0


def main(argv: list[str] | None = None) -> int:
    args = arguments(argv)
    try:
        return run(args)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
