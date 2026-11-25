"""Refresh the Discover guest's bundled horizon crops from the approved Home wallpapers."""
from pathlib import Path

from PIL import Image

package = Path(__file__).resolve().parent
sources = package.parents[1] / "assets" / "shell"
for theme in ("morning", "night"):
    filename = f"launch-{theme}.jpg"
    with Image.open(sources / filename) as original:
        # Preserve the full launch trail and horizon at a compact landscape ratio.
        width, height = original.size
        crop_height = round(width * 272 / 676)
        horizon = original.crop((0, height - crop_height, width, height))
        horizon.resize((676, 272), Image.Resampling.LANCZOS).save(
            package / "artwork" / filename, quality=88, subsampling=0, optimize=True
        )
