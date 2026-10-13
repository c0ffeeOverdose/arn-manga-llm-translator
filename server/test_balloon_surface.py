import io
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import app
from balloon_surface import balloon_surface, refine_balloon_boxes


def fixture(together=False, open_surface=False, tone=255, outside=None, scale=1, close=False):
    w, h = int(200 * scale), int(120 * scale)
    rgb = np.full((h, w, 3), tone if outside is None else outside, dtype=np.uint8)
    mask = np.zeros((h, w), dtype=bool)

    def rect(x1, y1, x2, y2, value, text=False):
        xs, xe, ys, ye = int(np.floor(x1 * scale)), int(np.ceil(x2 * scale)), int(np.floor(y1 * scale)), int(np.ceil(y2 * scale))
        rgb[ys:ye, xs:xe] = value
        if text:
            mask[ys:ye, xs:xe] = True

    def outline(x1, x2):
        rect(x1, 20, x2, 82, tone)
        for coords in [(x1, 20, x2, 22), (x1, 80, x2, 82), (x1, 20, x1 + 2, 82), (x2 - 2, 20, x2, 82)]:
            rect(*coords, 255 - tone)

    if not open_surface:
        if together:
            outline(20, 158)
        elif close:
            outline(20, 55)
            outline(55, 100)
        else:
            outline(20, 87)
            outline(90, 158)
    for x in ([25, 40, 58, 73] if close else [45, 60, 105, 120]):
        rect(x, 40, x + 10, 58, 255 - tone, True)
    box = {"x1": (23 if close else 43) * scale, "y1": 38 * scale,
           "x2": (85 if close else 132) * scale, "y2": 60 * scale, "conf": 0.9}
    return rgb, mask, box


class BalloonGeometry(unittest.TestCase):
    def test_two_surfaces_split_without_losing_text(self):
        for scale in (0.5, 1, 2):
            for tone in (255, 0):
                rgb, mask, box = fixture(tone=tone, scale=scale)
                original = rgb.copy()
                result = refine_balloon_boxes(rgb, [box], mask)
                self.assertEqual(len(result), 2)
                self.assertLess(result[0]["clip"]["x2"], result[1]["clip"]["x1"])
                self.assertLessEqual(result[0]["x1"], 45 * scale)
                self.assertGreaterEqual(result[0]["x2"], 70 * scale)
                self.assertTrue(np.array_equal(rgb, original))

    def test_unknown_and_shared_surfaces_keep_the_proposal(self):
        for options in ({"together": True}, {"open_surface": True}):
            rgb, mask, box = fixture(**options)
            self.assertEqual(refine_balloon_boxes(rgb, [box], mask), [box])
        rgb, mask, box = fixture()
        mask[40:58, 86:92] = True
        self.assertEqual(refine_balloon_boxes(rgb, [box], mask), [box])

    def test_regular_lines_merge_but_separate_paragraphs_and_columns_do_not(self):
        rgb, mask, _ = fixture(together=True)
        boxes = [{"x1": 45, "y1": y, "x2": 100, "y2": y + 18, "conf": 0.9} for y in (30, 55)]
        self.assertEqual(refine_balloon_boxes(rgb, boxes, mask), [{"x1": 45, "y1": 30, "x2": 100, "y2": 73, "conf": 0.9}])
        paragraphs = [boxes[0], dict(boxes[1], y1=65, y2=83)]
        self.assertEqual(refine_balloon_boxes(rgb, paragraphs, mask), paragraphs)
        columns = [dict(b, x2=b["x1"] + 8) for b in boxes]
        self.assertEqual(refine_balloon_boxes(rgb, columns, mask), columns)
        empty_line = [{"x1": 45, "y1": y, "x2": 100, "y2": y + 10, "conf": 0.9} for y in (25, 39)]
        self.assertEqual(refine_balloon_boxes(rgb, empty_line, mask), empty_line)

    def test_gray_exterior_and_close_twins(self):
        for options in ({"outside": 180}, {"close": True}):
            rgb, mask, box = fixture(**options)
            self.assertEqual(len(refine_balloon_boxes(rgb, [box], mask)), 2)

    def test_measurement_looks_past_a_clip_without_mutating_it(self):
        rgb, mask, _ = fixture(together=True)
        box = {"x1": 43, "y1": 38, "x2": 72, "y2": 60, "conf": 0.9,
               "clip": {"x1": 43, "y1": 38, "x2": 80, "y2": 60}, "cutAxis": "x"}
        surface = balloon_surface(rgb, box, mask, [], dict(box, x2=132))
        self.assertIsNotNone(surface)
        self.assertEqual((surface["x1"], surface["x2"]), (22, 156))
        self.assertEqual(box["clip"]["x2"], 80)

    def test_frame_repair_absorbs_a_one_pixel_jitter_and_deep_overlap_still_refuses(self):
        from balloon_surface import split_connected_clusters

        def comps(shift=0):
            return [
                {"x1": 20, "y1": 40, "x2": 90, "y2": 60, "conf": 0.9}, {"x1": 20, "y1": 66, "x2": 90, "y2": 86, "conf": 0.9},
                {"x1": 90 + shift, "y1": 84, "x2": 150 + shift, "y2": 104, "conf": 0.9},
                {"x1": 90 + shift, "y1": 110, "x2": 150 + shift, "y2": 130, "conf": 0.9},
            ]
        parent = {"x1": 20, "y1": 40, "x2": 150, "y2": 130, "conf": 0.9}
        pieces = split_connected_clusters(comps(0), parent, 220, 180)
        self.assertIsNotNone(pieces)
        self.assertEqual(len(pieces), 2)
        self.assertEqual(pieces[0]["clip"]["x2"], 90)
        repaired = split_connected_clusters(comps(-1), parent, 220, 180)
        self.assertIsNotNone(repaired, "a 1px sibling intrusion must be repaired, not vetoed")
        self.assertEqual(repaired[0]["clip"]["x2"], 89)
        self.assertIsNone(split_connected_clusters(comps(-30), parent, 220, 180),
                          "sibling ink inside the child bbox cannot be repaired")
        for dy in (1, -1):
            jittered = [dict(c, y1=c["y1"] + dy, y2=c["y2"] + dy) if i >= 2 else c for i, c in enumerate(comps(0))]
            self.assertIsNotNone(split_connected_clusters(jittered, parent, 220, 180), f"±1px y jitter ({dy}) must not stop the split")


class GroupingBeforeOcr(unittest.IsolatedAsyncioTestCase):
    async def test_actual_page_path_splits_physical_twins_before_ocr_and_patch_indices(self):
        rgb, mask, box = fixture(close=True)
        image = Image.fromarray(rgb)
        body = io.BytesIO()
        image.save(body, format="PNG")

        class Request:
            async def body(self):
                return body.getvalue()

        raw_box = [[box[k] for k in ("x1", "y1", "x2", "y2")]]
        inference = (raw_box, [0.9], raw_box, [0.9], mask.astype(np.float32), 1)

        crops, clean_boxes = [], []

        def ocr(crop):
            crops.append(crop)
            return str(len(crops)), 1

        def clean(_pil, boxes, *_args, **_kwargs):
            clean_boxes.extend(boxes)
            return [{"i": i} for i in range(len(boxes))], len(boxes), 1, 0

        with patch.object(app, "infer_once", return_value=inference), patch.object(app, "run_baberu", side_effect=ocr), patch.object(app, "run_inpaint", side_effect=clean):
            result = await app.page(Request(), conf_thr=0.35, min_size=12, inpaint_flag=1, texts_flag=1, pad_ratio=0.5)
        self.assertEqual(result["texts"], ["1", "2"])
        self.assertEqual(len(clean_boxes), 2)
        self.assertEqual([p["i"] for p in result["patches"]], [0, 1])
        self.assertTrue(all("clip" in b for b in result["boxes"]))
        self.assertLess(crops[0].width, 40)
        self.assertLess(crops[1].width, 50)
