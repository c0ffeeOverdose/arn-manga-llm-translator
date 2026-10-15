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


def clover_fixture(text_rects):
    """Union of two overlapping circles (mirror of the TS cloverFixture): one shared interior."""
    w, h = 260, 200
    rgb = np.full((h, w, 3), 255, dtype=np.uint8)
    mask = np.zeros((h, w), dtype=bool)
    c1, c2 = (80, 100, 52), (180, 100, 52)

    def inside(x, y):
        return ((x - c1[0]) ** 2 + (y - c1[1]) ** 2 <= c1[2] ** 2
                or (x - c2[0]) ** 2 + (y - c2[1]) ** 2 <= c2[2] ** 2)

    for y in range(h):
        for x in range(w):
            if inside(x, y) and (x == 0 or y == 0 or x == w - 1 or y == h - 1
                                 or not inside(x - 1, y) or not inside(x + 1, y)
                                 or not inside(x, y - 1) or not inside(x, y + 1)):
                rgb[y, x] = 0
    for (x1, y1, x2, y2) in text_rects:
        rgb[y1:y2, x1:x2] = 0
        mask[y1:y2, x1:x2] = True
    return rgb, mask


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

    def test_cut_family_redecides_on_its_union(self):
        # one lobe's sentence sitting on both sides of a detector cut must reunite
        rgb, mask = clover_fixture([
            (45, 70, 95, 90), (99, 70, 120, 90), (45, 96, 115, 116),
            (150, 70, 215, 90), (150, 96, 215, 116), (150, 122, 200, 142),
        ])
        base = {"x1": 40, "y1": 60, "x2": 228, "y2": 146, "conf": 0.9}
        members = [
            dict(base, y2=92, sib=0, cutAxis="y", clip={"x1": 40, "y1": 58, "x2": 228, "y2": 100}),
            dict(base, y1=92, sib=0, cutAxis="y", clip={"x1": 40, "y1": 84, "x2": 228, "y2": 148}),
        ]
        out = refine_balloon_boxes(rgb, members, mask)
        self.assertEqual(len(out), 2, "one region per lobe, not per fragment on the cut")
        right = next((b for b in out if b["x1"] >= 140), None)
        left = next((b for b in out if b["x1"] < 140), None)
        self.assertIsNotNone(right)
        self.assertIsNotNone(left)
        self.assertLessEqual(right["x1"], 150)
        self.assertGreaterEqual(right["x2"], 215)
        self.assertLessEqual(right["y1"], 70)
        self.assertGreaterEqual(right["y2"], 142)
        self.assertLessEqual(left["x1"], 45)
        self.assertGreaterEqual(left["x2"], 120)
        self.assertGreaterEqual(left["y2"], 116)

    def test_cut_families_stay_untouched_without_one_enclosure_and_two_blocks(self):
        # separate enclosures: the union resolves two surfaces, so the cut's children stand
        rgb, mask, box = fixture()
        m1 = dict(box, x2=85, sib=7, cutAxis="x", clip={"x1": 43, "y1": 38, "x2": 88, "y2": 60})
        m2 = dict(box, x1=104, sib=7, cutAxis="x", clip={"x1": 100, "y1": 38, "x2": 132, "y2": 60})
        self.assertEqual(refine_balloon_boxes(rgb, [m1, m2], mask), [m1, m2])
        # one text block only: nothing to re-split, children stand
        rgb2, mask2 = clover_fixture([(150, 70, 215, 90), (150, 96, 215, 116)])
        base = {"x1": 140, "y1": 60, "x2": 228, "y2": 146, "conf": 0.9}
        single = [
            dict(base, y2=92, sib=3, cutAxis="y", clip={"x1": 140, "y1": 58, "x2": 228, "y2": 100}),
            dict(base, y1=92, sib=3, cutAxis="y", clip={"x1": 140, "y1": 84, "x2": 228, "y2": 148}),
        ]
        self.assertEqual(refine_balloon_boxes(rgb2, single, mask2), single)
        # ink the surface measurement cannot resolve also keeps the cut
        rgb3, mask3 = clover_fixture([(45, 70, 95, 90), (99, 70, 120, 90), (150, 70, 215, 90), (150, 96, 215, 116)])
        rgb3[135:139, 222:226] = 0
        mask3[135:139, 222:226] = True
        stray = [
            dict(base, x2=228, y2=92, sib=3, cutAxis="y", clip={"x1": 40, "y1": 58, "x2": 228, "y2": 100}),
            dict(base, x1=40, y1=92, sib=3, cutAxis="y", clip={"x1": 40, "y1": 84, "x2": 228, "y2": 148}),
        ]
        self.assertEqual(refine_balloon_boxes(rgb3, stray, mask3), stray)

    def test_lone_oversized_lettering_splits_but_normal_words_do_not(self):
        from balloon_surface import split_connected_clusters

        dialog = [{"x1": 30, "y1": y, "x2": 150, "y2": y + 22, "conf": 0.9} for y in (180, 208, 236)]
        parent = {"x1": 20, "y1": 40, "x2": 160, "y2": 258, "conf": 0.9}
        sfx = {"x1": 25, "y1": 45, "x2": 80, "y2": 115, "conf": 0.9}  # 70 tall vs ~22px glyphs
        pieces = split_connected_clusters([sfx] + dialog, parent, 220, 260)
        self.assertIsNotNone(pieces, "SFX-scale lettering becomes its own region")
        self.assertEqual(len(pieces), 2)
        self.assertGreaterEqual(min(p["y1"] for p in pieces if p["y1"] >= 150), 150)
        small = dict(sfx, y2=75)  # 30 tall ≈ the block's glyph scale
        self.assertIsNone(split_connected_clusters([small] + dialog, parent, 220, 260),
                          "a lone normal-size word still never becomes a region")

    def test_display_lettering_glued_to_dialogue_splits_out(self):
        from balloon_surface import split_connected_clusters

        lettering = {"x1": 30, "y1": 40, "x2": 110, "y2": 150, "conf": 0.9}
        rows = [{"x1": 60, "y1": y, "x2": 200, "y2": y + 22, "conf": 0.9} for y in (146, 174, 202)]
        parent = {"x1": 20, "y1": 30, "x2": 210, "y2": 224, "conf": 0.9}
        pieces = split_connected_clusters([lettering] + rows, parent, 240, 320)
        self.assertIsNotNone(pieces, "lettering becomes its own region")
        self.assertEqual(len(pieces), 2)
        big = next(p for p in pieces if p["y2"] <= 160)
        self.assertLessEqual(big["y1"], 45)

    def test_lettering_absorbing_all_fragments_keeps_the_original_region(self):
        from balloon_surface import split_connected_clusters

        comps = [{"x1": 40, "y1": 40, "x2": 120, "y2": 150, "conf": 0.9},
                 {"x1": 20, "y1": 146, "x2": 45, "y2": 168, "conf": 0.9},
                 {"x1": 115, "y1": 146, "x2": 140, "y2": 168, "conf": 0.9}]
        parent = {"x1": 10, "y1": 30, "x2": 150, "y2": 180, "conf": 0.9}
        self.assertIsNone(split_connected_clusters(comps, parent, 200, 200))

    def test_interlocking_blocks_split_with_the_sliver_fallback(self):
        from balloon_surface import split_connected_clusters

        a = [[100, 40, 220, 63], [110, 68, 210, 91], [105, 96, 215, 119], [100, 124, 220, 147], [100, 152, 220, 175], [100, 180, 220, 205]]
        b = [[46, 192, 78, 214], [26, 217, 99, 241], [18, 242, 67, 265], [75, 242, 105, 265], [10, 270, 115, 293], [11, 294, 72, 318], [79, 295, 113, 318], [24, 322, 101, 345]]
        comps = [{"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": 0.9} for (x1, y1, x2, y2) in a + b]
        parent = {"x1": 5, "y1": 30, "x2": 225, "y2": 350, "conf": 0.9}
        pieces = split_connected_clusters(comps, parent, 260, 400)
        self.assertIsNotNone(pieces, "a 15x13px interlock still splits")
        self.assertEqual(len(pieces), 2)

    def test_short_dot_run_joins_the_nearest_block(self):
        from balloon_surface import split_connected_clusters

        def block(y0):
            return [{"x1": 40, "y1": y0 + k, "x2": 150, "y2": y0 + k + 22, "conf": 0.9} for k in (0, 28, 56)]
        dots = [{"x1": x1, "y1": 126, "x2": x2, "y2": 132, "conf": 0.9} for (x1, x2) in ((60, 64), (64, 68), (68, 72))]
        parent = {"x1": 30, "y1": 30, "x2": 160, "y2": 260, "conf": 0.9}
        pieces = split_connected_clusters(block(40) + dots + block(180), parent, 240, 300)
        self.assertIsNotNone(pieces, "the dots ride the upper block, the two blocks split")
        self.assertEqual(len(pieces), 2)
        upper = next(p for p in pieces if p["y1"] < 100)
        self.assertGreaterEqual(upper["y2"], 132)

    def test_a_mid_column_seam_never_splits_one_column_in_half(self):
        from balloon_surface import split_connected_clusters

        rows = [[163, 26, 192, 58], [106, 62, 229, 96], [228, 62, 248, 94], [97, 99, 173, 131], [181, 100, 257, 133],
                [150, 135, 204, 168], [181, 172, 244, 206], [111, 173, 182, 206], [134, 210, 220, 243]]
        comps = [{"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": 0.9} for (x1, y1, x2, y2) in rows]
        parent = {"x1": 90, "y1": 20, "x2": 265, "y2": 250, "conf": 0.9}
        self.assertIsNone(split_connected_clusters(comps, parent, 300, 320),
                          "a stacked seam inside one column of text is not a block boundary")

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

        with patch.object(app, "ctd", object()), patch.object(app, "infer_once", return_value=inference), \
                patch.object(app, "run_baberu", side_effect=ocr), patch.object(app, "run_inpaint", side_effect=clean):
            result = await app.page(Request(), conf_thr=0.35, min_size=12, inpaint_flag=1, texts_flag=1, pad_ratio=0.5, layout_model="ctd")
        self.assertEqual(result["texts"], ["1", "2"])
        self.assertEqual(len(clean_boxes), 2)
        self.assertEqual([p["i"] for p in result["patches"]], [0, 1])
        self.assertTrue(all("clip" in b for b in result["boxes"]))
        self.assertLess(crops[0].width, 40)
        self.assertLess(crops[1].width, 50)
