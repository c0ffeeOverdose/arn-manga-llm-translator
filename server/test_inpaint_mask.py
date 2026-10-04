import io
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import app
from app import cleanup_mask, inpaint_dilate_radius


class CleanupMask(unittest.TestCase):
    """The merged /v1/page inpaint pass must erase with the client's prepared mask
    (restrict to boxes + dilate), not the raw CTD mask — a thin mask leaves glyph edges."""

    def test_mask_is_restricted_to_the_boxes(self):
        raw = np.ones((100, 100), dtype=bool)
        mask = cleanup_mask(raw, [{"x1": 10, "y1": 10, "x2": 40, "y2": 40}], 100, 100)
        self.assertTrue(mask[20:30, 20:30].all())
        self.assertFalse(mask[:6, :].any())  # beyond the dilation radius
        self.assertFalse(mask[:, 46:].any())

    def test_thin_stroke_is_dilated_by_the_client_radius(self):
        r = inpaint_dilate_radius(200, 200)
        raw = np.zeros((200, 200), dtype=bool)
        raw[100, 50:150] = True  # a 1px stroke
        mask = cleanup_mask(raw, [{"x1": 40, "y1": 90, "x2": 160, "y2": 110}], 200, 200)
        # the stroke now spans r px on each side
        self.assertTrue(mask[100 - r, 100])
        self.assertTrue(mask[100 + r, 100])
        self.assertFalse(mask[100 - r - 1, 100])
        self.assertFalse(mask[100 + r + 1, 100])

    def test_out_of_range_boxes_are_clipped(self):
        raw = np.ones((50, 50), dtype=bool)
        mask = cleanup_mask(raw, [{"x1": -20, "y1": -20, "x2": 200, "y2": 200}], 50, 50)
        self.assertTrue(mask.any())
        self.assertFalse(cleanup_mask(raw, [{"x1": 60, "y1": 60, "x2": 80, "y2": 80}], 50, 50).any())


class MergedInpaint(unittest.IsolatedAsyncioTestCase):
    async def test_page_merged_inpaint_uses_the_prepared_mask(self):
        source = io.BytesIO()
        Image.new("RGB", (200, 200), "white").save(source, format="PNG")

        class Request:
            async def body(self):
                return source.getvalue()

        raw = np.zeros((200, 200), dtype=bool)
        raw[100, 50:150] = True  # a thin glyph stroke
        boxes = [{"x1": 40, "y1": 90, "x2": 160, "y2": 110, "conf": 0.9}]
        seen = {}

        def fake_inpaint(pil, bxs, pad_ratio, mask=None):
            seen["mask"] = mask
            return [], 0, 0.0, 0.0

        with patch.object(app, "run_detect", return_value=(boxes, 1, {"w": 1, "h": 1, "b64": "AA=="}, raw)), \
                patch.object(app, "run_baberu", return_value=("", 1.0)), \
                patch.object(app, "run_inpaint", side_effect=fake_inpaint):
            await app.page(Request(), conf_thr=0.35, min_size=12, inpaint_flag=1, pad_ratio=0.5)

        mask = seen["mask"]
        self.assertIsNotNone(mask, "merged pass must receive a mask")
        self.assertFalse(np.array_equal(mask, raw), "the raw CTD mask must not ride the merged pass")
        r = inpaint_dilate_radius(200, 200)
        self.assertTrue(mask[100 - r, 100] and mask[100 + r, 100], "stroke is dilated")
        self.assertFalse(mask[10, 10], "outside the boxes stays clear")


if __name__ == "__main__":
    unittest.main()
