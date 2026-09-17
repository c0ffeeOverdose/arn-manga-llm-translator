# Unit tests for server/split.py — the cloud port of splitMergedBoxes
# (src/content/detection.ts) and expandCropToInk (src/content/render.ts).
# Mirror of tests/box-split.test.mjs (+ crop cases): the same inputs must give
# the same boxes. Run: python3 -m unittest discover -s server -p 'test_*.py'
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from split import expand_crop_to_ink, split_merged_boxes

GAP = 28


def box(x1, y1, x2, y2, conf=0.9):
    return {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "conf": conf}


def rects(tuples):
    return [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for x1, y1, x2, y2 in tuples]


BOX2 = [[770, 120, 872, 151], [770, 156, 873, 182], [759, 186, 838, 215], [849, 192, 884, 222],
        [592, 200, 643, 228], [655, 200, 732, 227], [601, 237, 680, 260], [675, 237, 728, 293],
        [599, 271, 664, 294], [657, 298, 732, 326], [597, 304, 656, 326], [618, 332, 706, 360]]

P7 = [[63, 793, 134, 814],
      [66, 883, 125, 900], [57, 905, 83, 922], [83, 905, 98, 921],
      [106, 905, 143, 921], [48, 926, 96, 943], [103, 926, 151, 942],
      [70, 948, 129, 965], [55, 969, 92, 986], [93, 969, 144, 986],
      [106, 990, 154, 1007], [45, 991, 97, 1009]]

MD4 = [[609, 73, 629, 90], [585, 95, 611, 111], [614, 95, 653, 111],
       [565, 117, 583, 132], [587, 117, 612, 133], [615, 117, 675, 133],
       [498, 120, 533, 145], [560, 138, 570, 153], [572, 138, 613, 154],
       [617, 138, 677, 154], [490, 152, 539, 176], [611, 159, 654, 176],
       [584, 160, 609, 176], [595, 181, 613, 197], [618, 181, 642, 198],
       [482, 182, 552, 207], [590, 203, 645, 220], [600, 224, 636, 241]]


class SplitTest(unittest.TestCase):
    def test_lane1_two_balloon_box_splits(self):
        parent = box(1061, 362, 1413, 825, 0.92)
        comps = rects([[1329, 376, 1392, 416], [1312, 453, 1393, 502], [1390, 460, 1408, 502],
                       [1145, 568, 1196, 610], [1207, 568, 1279, 612], [1063, 576, 1135, 612],
                       [1235, 640, 1287, 682], [1129, 648, 1224, 682], [1062, 650, 1116, 683],
                       [1084, 710, 1150, 755], [1164, 713, 1258, 756],
                       [1074, 777, 1148, 826], [1161, 783, 1266, 827]])
        self.assertEqual(split_merged_boxes([parent], comps, GAP), [
            {"x1": 1312, "y1": 376, "x2": 1408, "y2": 535, "conf": 0.92,
             "clip": {"x1": 1061, "y1": 362, "x2": 1413, "y2": 547}, "cutAxis": "y"},
            {"x1": 1062, "y1": 535, "x2": 1287, "y2": 825, "conf": 0.92,
             "clip": {"x1": 1061, "y1": 523, "x2": 1413, "y2": 825}, "cutAxis": "y"},
        ])

    def test_lane1_guards_hold(self):
        # in-block line spacing below the floor never splits
        p = box(100, 100, 300, 400)
        line = rects([[110, 110, 290, 140], [110, 150, 290, 180], [110, 190, 290, 220]])
        self.assertEqual(split_merged_boxes([p], line, GAP), [p])
        # stacked runs sharing the cross axis never split
        stacked = rects([[110, 110, 290, 150], [110, 200, 290, 240]])
        self.assertEqual(split_merged_boxes([p], stacked, GAP), [p])
        # words on one line (large x gaps, same y) do not split
        words = rects([[110, 110, 160, 140], [220, 110, 270, 140]])
        self.assertEqual(split_merged_boxes([p], words, GAP), [p])

    def test_lane2_side_by_side_27px(self):
        parent = box(594, 118, 887, 362, 0.95)
        parts = split_merged_boxes([parent], rects(BOX2), GAP)
        self.assertEqual([[p["x1"], p["y1"], p["x2"], p["y2"]] for p in parts],
                         [[594, 200, 745, 360], [746, 120, 884, 222]])
        self.assertEqual([p["clip"] for p in parts],
                         [{"x1": 594, "y1": 118, "x2": 758, "y2": 362},
                          {"x1": 734, "y1": 118, "x2": 887, "y2": 362}])

    def test_lane2_15px_overlap_72px(self):
        parent = box(968, 843, 1274, 1113, 0.88)
        comps = rects([[1177, 851, 1248, 879], [1151, 884, 1232, 946], [1243, 884, 1269, 912],
                       [1217, 917, 1274, 945], [1047, 946, 1136, 975], [972, 948, 1039, 980],
                       [1163, 949, 1199, 978], [1208, 950, 1263, 978], [979, 980, 1039, 1008],
                       [1175, 984, 1250, 1018], [1049, 985, 1130, 1008], [985, 1012, 1066, 1042],
                       [1075, 1018, 1123, 1041], [979, 1046, 1003, 1074], [1003, 1046, 1082, 1074],
                       [1093, 1046, 1130, 1074], [1029, 1080, 1094, 1108], [1011, 1086, 1028, 1106]])
        parts = split_merged_boxes([parent], comps, GAP)
        self.assertEqual([[p["x1"], p["y1"], p["x2"], p["y2"]] for p in parts],
                         [[972, 946, 1143, 1108], [1144, 851, 1274, 1018]])

    def test_lane2_fuse_guards(self):
        # same-span caption block stays whole
        p = box(1149, 1439, 1334, 1653, 0.9)
        mid = rects([[1199, 1447, 1325, 1498], [1163, 1448, 1189, 1471], [1167, 1471, 1205, 1496],
                     [1175, 1498, 1312, 1546], [1247, 1547, 1303, 1571], [1184, 1548, 1241, 1572],
                     [1156, 1572, 1304, 1597], [1311, 1573, 1329, 1596], [1181, 1598, 1308, 1622],
                     [1149, 1624, 1333, 1648]])
        self.assertEqual(split_merged_boxes([p], mid, GAP), [p])
        # nested single line under its block stays fused
        p2 = box(0, 0, 300, 700, 0.4)
        comps = [box(20, 0, 280, 80), box(20, 100, 280, 180), box(20, 200, 280, 280),
                 box(20, 300, 280, 380), box(120, 500, 250, 570)]
        self.assertEqual(split_merged_boxes([p2], comps, GAP), [p2])

    def test_lane2_diagonal_two_line_groups(self):
        parent = box(1061, 362, 1413, 825, 0.92)
        comps = [box(1305, 369, 1413, 415), box(1305, 448, 1413, 504),
                 box(1062, 534, 1287, 575), box(1062, 600, 1287, 640)]
        self.assertEqual(split_merged_boxes([parent], comps, GAP), [
            {"x1": 1305, "y1": 369, "x2": 1413, "y2": 519, "conf": 0.92,
             "clip": {"x1": 1061, "y1": 362, "x2": 1413, "y2": 531}, "cutAxis": "y"},
            {"x1": 1062, "y1": 519, "x2": 1287, "y2": 640, "conf": 0.92,
             "clip": {"x1": 1061, "y1": 507, "x2": 1413, "y2": 825}, "cutAxis": "y"},
        ])

    def test_yes_lobe_splits(self):
        parent = box(108, 500, 211, 621, 0.9)
        comps = [box(180, 504, 211, 517), box(114, 565, 168, 580),
                 box(117, 584, 165, 599), box(112, 603, 170, 618)]
        self.assertEqual(split_merged_boxes([parent], comps, GAP, comps), [
            {"x1": 180, "y1": 504, "x2": 211, "y2": 541, "conf": 0.9,
             "clip": {"x1": 108, "y1": 500, "x2": 211, "y2": 553}, "cutAxis": "y"},
            {"x1": 112, "y1": 541, "x2": 170, "y2": 618, "conf": 0.9,
             "clip": {"x1": 108, "y1": 529, "x2": 211, "y2": 621}, "cutAxis": "y"},
        ])

    def test_md4_twin_cut(self):
        parent = box(477, 76, 679, 239, 0.62)
        kids = split_merged_boxes([parent], rects(MD4), GAP, rects(MD4))
        self.assertEqual(len(kids), 2)
        self.assertEqual([kids[0]["x1"], kids[0]["y1"], kids[0]["x2"], kids[0]["y2"]],
                         [482, 120, 558, 207])
        self.assertEqual([kids[1]["x1"], kids[1]["y1"], kids[1]["x2"], kids[1]["y2"]],
                         [559, 76, 677, 239])
        self.assertEqual(kids[0]["cutAxis"], "x")
        self.assertEqual([kids[0]["clip"]["x1"], kids[0]["clip"]["x2"]], [477, 565])
        self.assertEqual([kids[1]["clip"]["x1"], kids[1]["clip"]["x2"]], [553, 679])

    def test_twin_cut_guards(self):
        # vertical-text columns never x-split
        p = box(100, 100, 300, 400, 0.9)
        cols = [box(110, 110, 140, 390), box(155, 110, 185, 390),
                box(200, 110, 230, 390), box(245, 110, 275, 390)]
        self.assertEqual(split_merged_boxes([p], cols, GAP, cols), [p])
        # a word gap crossed by a full-width line is no avenue
        p2 = box(400, 100, 700, 200, 0.9)
        words = [box(410, 105, 690, 130), box(410, 140, 480, 165),
                 box(500, 140, 570, 165), box(590, 140, 660, 165)]
        self.assertEqual(split_merged_boxes([p2], words, GAP, words), [p2])

    def test_p7_whoa_splits(self):
        parent = box(42, 782, 153, 1010, 0.78)
        kids = split_merged_boxes([parent], rects(P7), GAP, rects(P7))
        self.assertEqual(len(kids), 2)
        self.assertEqual([kids[0]["x1"], kids[0]["y1"], kids[0]["x2"], kids[0]["y2"]],
                         [63, 793, 134, 848])
        self.assertEqual([kids[1]["x1"], kids[1]["y1"], kids[1]["x2"], kids[1]["y2"]],
                         [45, 849, 153, 1009])

    def test_short_first_guards(self):
        # short LAST group with a big gap is the dropped-line case — fused
        p = box(42, 700, 153, 950, 0.8)
        comps = [box(48, 710, 150, 730), box(48, 742, 150, 762),
                 box(48, 774, 150, 794), box(80, 866, 120, 884)]
        self.assertEqual(split_merged_boxes([p], comps, GAP, comps), [p])
        # short first group with a line-size gap is a paragraph — fused
        comps2 = [box(60, 710, 130, 728), box(48, 738, 150, 758),
                  box(48, 770, 150, 790), box(48, 802, 150, 822)]
        self.assertEqual(split_merged_boxes([p], comps2, GAP, comps2), [p])


def white_with(rects_ink=(), gray=(), size=200):
    img = np.full((size, size, 3), 255, np.uint8)
    for x1, y1, x2, y2 in rects_ink:
        img[y1:y2 + 1, x1:x2 + 1] = 0
    for x1, y1, x2, y2 in gray:
        img[y1:y2 + 1, x1:x2 + 1] = 212
    return img


class CropTest(unittest.TestCase):
    def _rect(self, b, pad):
        return {"x": max(0, int(b["x1"] - pad)), "y": max(0, int(b["y1"] - pad)),
                "w": int(b["x2"] - b["x1"] + 2 * pad), "h": int(b["y2"] - b["y1"] + 2 * pad)}

    def test_cut_glyph_grows(self):
        # black bar crosses the box's bottom edge over part of its width
        rgb = white_with([(60, 100, 120, 110)])
        b = {"x1": 50, "y1": 60, "x2": 150, "y2": 105}
        r = expand_crop_to_ink(rgb, b, self._rect(b, 4.5))
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (45, 55, 109, 59))

    def test_gray_wall_does_not_grow(self):
        # same geometry in screentone gray (|212-255| < 90): not ink, no growth
        rgb = white_with(gray=[(60, 100, 120, 110)])
        b = {"x1": 50, "y1": 60, "x2": 150, "y2": 105}
        r = expand_crop_to_ink(rgb, b, self._rect(b, 4.5))
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (45, 55, 109, 54))

    def test_crossing_rule_grows_like_ts(self):
        # a full-width bar crossing the side edge is NOT caught by the >=60%
        # rule (that only stops rules running ALONG the edge) — the TS original
        # grows along it too, so this locks parity, not the wish.
        rgb = white_with([(0, 100, 199, 110)])
        b = {"x1": 50, "y1": 60, "x2": 150, "y2": 105}
        r = expand_crop_to_ink(rgb, b, self._rect(b, 4.5))
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (27, 55, 146, 54))

    def test_split_clip_contains_growth(self):
        # tall ink block below: unclipped growth reaches for it, the split
        # clip holds the crop at the cut
        rgb = white_with([(60, 100, 120, 130)])
        b = {"x1": 50, "y1": 60, "x2": 150, "y2": 105}
        noclipr = expand_crop_to_ink(rgb, b, self._rect(b, 4.5))
        self.assertEqual(noclipr["y"] + noclipr["h"], 128)
        clipped = dict(b, clip={"x1": 0, "y1": 0, "x2": 199, "y2": 106})
        r = expand_crop_to_ink(rgb, clipped, self._rect(b, 4.5))
        self.assertEqual((r["x"], r["y"], r["w"], r["h"]), (45, 55, 109, 54))


if __name__ == "__main__":
    unittest.main()


class PackTest(unittest.TestCase):
    def test_pack_mask_matches_client_codec(self):
        # independent re-implementation of packMask (page-cache.ts): block-max
        # downscale to <=256, threshold >127. Any divergence breaks the
        # client's unpackMask restore of the server mask.
        import math
        from split import pack_mask

        def ts_pack(w, h, flat, max_side=256):
            step = max(1, math.floor(max(w, h) / max_side))
            ow, oh = math.ceil(w / step), math.ceil(h / step)
            out = bytearray(ow * oh)
            for y in range(oh):
                for x in range(ow):
                    v = 0
                    for yy in range(y * step, min(y * step + step, h)):
                        for xx in range(x * step, min(x * step + step, w)):
                            p = flat[yy * w + xx]
                            if p > v:
                                v = p
                    out[y * ow + x] = 255 if v > 127 else 0
            return ow, oh, bytes(out)

        import random
        random.seed(7)
        for w, h in [(752, 1080), (100, 100), (300, 10), (5, 5), (256, 256), (1000, 3)]:
            flat = bytes(random.choice((0, 0, 0, 255)) for _ in range(w * h))
            self.assertEqual(pack_mask(w, h, flat), ts_pack(w, h, flat), (w, h))


MD14_TEXTY = [[467, 409, 508, 446], [471, 443, 514, 478], [543, 409, 586, 474],
              [613, 390, 644, 405], [608, 409, 648, 425], [610, 429, 645, 445],
              [617, 479, 630, 494], [596, 498, 648, 514], [591, 518, 652, 533],
              [597, 537, 639, 552]]


class RescueTest(unittest.TestCase):
    def setUp(self):
        from split import rescue_split_comp
        self.rescue = rescue_split_comp
        self.texty = [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for x1, y1, x2, y2 in MD14_TEXTY]

    def dense(self, mean=0.85):
        def count_in(x1, y1, x2, y2):
            area = (x2 - x1) * (y2 - y1)
            return area * 0.1, area * 0.1 * mean
        return count_in

    def overlaps_box5(self, r):
        return not (r["x2"] <= 594.9 or r["x1"] >= 650.8
                    or r["y2"] <= 389.5 or r["y1"] >= 553.3)

    def test_chained_comp_splits_outside_piece_survives(self):
        out = self.rescue({"x1": 467, "y1": 390, "x2": 652, "y2": 552},
                          self.texty, self.texty, GAP, 752 * 1080,
                          self.dense(), self.overlaps_box5, lambda r: 0)
        self.assertEqual(len(out), 1)
        self.assertLessEqual(out[0]["x2"], 594.9)
        self.assertLessEqual(out[0]["x1"], 470)
        self.assertLessEqual(out[0]["y1"], 412)
        self.assertEqual(out[0]["conf"], 0.5)

    def test_gapless_comp_stays_dead(self):
        texty = [{"x1": 600, "y1": 400, "x2": 640, "y2": 540}]
        out = self.rescue({"x1": 595, "y1": 390, "x2": 651, "y2": 553},
                          texty, texty, GAP, 752 * 1080,
                          self.dense(), self.overlaps_box5, lambda r: 0)
        self.assertEqual(out, [])

    def test_sparse_piece_fails_fill_regate(self):
        out = self.rescue({"x1": 467, "y1": 390, "x2": 652, "y2": 552},
                          self.texty, self.texty, GAP, 752 * 1080,
                          lambda *a: (1, 0.85), lambda r: False, lambda r: 0)
        self.assertEqual(out, [])


MD14_RIGHT = [[613, 390, 644, 405], [608, 409, 648, 425], [610, 429, 645, 445],
              [617, 479, 630, 494], [596, 498, 648, 514], [591, 518, 652, 533],
              [597, 537, 639, 552]]


class FirstPairTest(unittest.TestCase):
    def setUp(self):
        from split import split_merged_boxes
        self.split = split_merged_boxes

    def comps(self, tuples):
        return [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for x1, y1, x2, y2 in tuples]

    def test_nested_top_group_of_comparable_size_splits(self):
        parent = {"x1": 594.9, "y1": 389.5, "x2": 650.8, "y2": 553.3, "conf": 0.68}
        cs = self.comps(MD14_RIGHT)
        kids = self.split([parent], cs, GAP, cs)
        self.assertEqual(len(kids), 2)
        self.assertLessEqual(kids[0]["y2"], kids[1]["y1"])
        self.assertLessEqual(kids[0]["y1"], 392)
        self.assertGreaterEqual(kids[0]["y2"], 443)
        self.assertLessEqual(kids[0]["y2"], 479)
        self.assertGreaterEqual(kids[1]["y2"], 550)
        self.assertEqual(kids[0]["cutAxis"], "y")

    def test_small_bottom_straggler_stays_fused(self):
        parent = {"x1": 42, "y1": 700, "x2": 200, "y2": 940, "conf": 0.8}
        cs = self.comps([[48, 710, 150, 750], [48, 758, 150, 790], [80, 910, 120, 928]])
        self.assertEqual(self.split([parent], cs, GAP, cs), [parent])
