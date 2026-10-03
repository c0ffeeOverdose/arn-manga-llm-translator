import io
import json
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import app
from split import SPLIT_GEN


class DetectionResponse(unittest.IsolatedAsyncioTestCase):
    def test_boxed_text_cannot_bridge_two_mask_only_groups(self):
        prob = np.zeros((120, 200), np.float32)
        for x in [20, 75, 130]:
            prob[20:40, x:x + 30] = 0.9
            prob[23:37, x + 8:x + 20] = 0
        inference = ([[75, 20, 105, 40]], [0.9], [[75, 20, 105, 40]], [0.9], prob, 1)
        with patch.object(app, "infer_once", return_value=inference):
            boxes, *_ = app.run_detect(Image.new("RGB", (200, 120), "white"), 0.35, 12)
        self.assertEqual(len(boxes), 3)
        self.assertTrue(any(b["x1"] <= 20 and b["x2"] >= 50 for b in boxes))
        self.assertTrue(any(b["x1"] <= 130 and b["x2"] >= 160 for b in boxes))

    async def test_split_ownership_and_text_order_survive_json_response(self):
        source = io.BytesIO()
        Image.new("RGB", (100, 100), "white").save(source, format="PNG")

        class Request:
            async def body(self):
                return source.getvalue()

        clip = {"x1": np.float32(5.25), "y1": np.float32(15.5), "x2": 35, "y2": 70}
        boxes = [{"x1": np.float32(10.25), "y1": 20, "x2": 30, "y2": 60, "conf": 0.9,
                  "clip": clip, "cutAxis": "x"},
                 {"x1": 60, "y1": 20, "x2": 80, "y2": 60, "conf": 0.8}]
        mask = {"w": 1, "h": 1, "b64": "AA=="}
        with patch.object(app, "run_detect", return_value=(boxes, 1, mask, np.zeros((100, 100), bool))), \
                patch.object(app, "run_baberu", side_effect=[("first source", 1), ("second source", 1)]):
            response = await app.page(Request(), conf_thr=0.35, min_size=12, inpaint_flag=0, pad_ratio=0.5)
        wire = json.loads(json.dumps(response))
        self.assertEqual(wire["boxes"][0]["clip"], {k: float(v) for k, v in clip.items()})
        self.assertEqual(wire["boxes"][0]["cutAxis"], "x")
        self.assertNotIn("clip", wire["boxes"][1])
        self.assertEqual(wire["texts"], ["first source", "second source"])
        self.assertEqual(wire["splitGen"], SPLIT_GEN)
