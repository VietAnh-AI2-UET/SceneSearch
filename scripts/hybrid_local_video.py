"""Primary laptop entry point. Uses the caller's Python environment."""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hybrid_v2.laptop_cli import main

if __name__ == "__main__":
    raise SystemExit(main())
