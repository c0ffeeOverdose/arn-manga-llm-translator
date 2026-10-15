import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import app
import koharu
import models_manifest as manifest


class KoharuDecode(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output = {"dets": np.zeros((1, 300, 4), np.float32),
                      "labels": np.zeros((1, 300, 5), np.float32),
                      "masks": np.zeros((1, 300, 288, 288), np.float32)}

    def setUp(self):
        self.output["dets"].fill(0)
        self.output["labels"].fill(-20)
        self.output["masks"].fill(-1)

    def instance(self, q, cls, score, rect=(0.5, 0.5, 0.5, 0.5), ink=False):
        self.output["dets"][0, q] = rect
        self.output["labels"][0, q, cls] = np.log(score / (1 - score))
        if ink:
            self.output["masks"][0, q].fill(1)

    def test_text_effects_and_panels_use_independent_thresholds(self):
        self.instance(0, 0, 0.30, ink=True)
        self.instance(1, 1, 0.22)
        self.instance(2, 2, 0.70)
        self.instance(3, 3, 0.80)
        result = koharu.decode(self.output, 200, 400)
        self.assertEqual(len(result["boxes"]), 2)
        self.assertEqual(len(result["panels"]), 1)
        self.assertEqual(len(result["bubbles"]), 1)
        self.assertEqual([result["boxes"][0][k] for k in ["x1", "y1", "x2", "y2"]], [50, 100, 150, 300])
        self.assertTrue(result["mask"].all())
        self.assertEqual(len(koharu.decode(self.output, 200, 400, {"text": 0.4})["boxes"]), 1)

    def test_bubbles_panels_rejected_and_tiny_instances_never_erase(self):
        for q, cls, score in [(0, 0, 0.1), (1, 1, 0.1), (2, 2, 0.9), (3, 3, 0.9), (4, 4, 0.99)]:
            self.instance(q, cls, score, ink=True)
        result = koharu.decode(self.output, 20, 30)
        self.assertEqual(result["boxes"], [])
        self.assertFalse(result["mask"].any())
        self.instance(0, 0, 0.9, (0.5, 0.5, 0.01, 0.01), ink=True)
        self.assertFalse(koharu.decode(self.output, 20, 30, min_size=12)["mask"].any())

    def test_top_160_ranking_keeps_overlapping_boxes_without_nms(self):
        for q in range(161):
            self.instance(q, 0, 0.9 - q / 1000)
        self.assertEqual(len(koharu.decode(self.output, 2, 2, min_size=0)["boxes"]), 160)

    def test_balloon_spans_keep_holes_and_remain_independent_of_erase(self):
        self.instance(0, 2, 0.9, (0.5, 0.5, 1, 1))
        self.output["masks"][0, 0, :, :96] = 1
        self.output["masks"][0, 0, :, 192:] = 1
        result = koharu.decode(self.output, 6, 6)
        self.assertEqual(result["balloons"][0]["rows"][3], [0, 2, 4, 6])
        self.assertFalse(result["mask"].any())

    def test_mask_interpolates_logits_before_threshold_and_rejects_invalid_outputs(self):
        self.instance(0, 0, 0.9)
        self.output["masks"][0, 0, :, :144] = 1
        result = koharu.decode(self.output, 4, 1, min_size=0)
        self.assertEqual(result["mask"].tolist(), [[True, True, False, False]])
        self.output["masks"][0, 0, 0, 0] = np.nan
        with self.assertRaisesRegex(RuntimeError, "invalid values"):
            koharu.decode(self.output, 4, 1)
        with self.assertRaisesRegex(RuntimeError, "outputs"):
            koharu.decode({**self.output, "dets": self.output["labels"]}, 4, 1)

    def test_fractional_preprocessing_matches_native_fp32_reference(self):
        rgba = (np.arange(137 * 192 * 4) % 256).astype(np.uint8).reshape(192, 137, 4)
        actual = koharu.image_input(Image.fromarray(rgba[:, :, :3]), 115).ravel()
        reference = [(0, -1.8371890783), (110, -1.6326242685), (114, -1.3176308870),
                     (12996, 0.5069682002), (13224, 1.9168220758), (13225, -1.7312264442),
                     (18329, -1.0939903259), (26449, 2.1065795422), (28888, 0.0147638060), (39674, 2.3368687630)]
        self.assertTrue(all(abs(float(actual[i]) - value) < 2e-6 for i, value in reference))

    def test_tiled_layout_keeps_text_position_order_and_combines_masks(self):
        class Session:
            def run(_, names, feed):
                self.assertEqual(names, ["dets", "labels", "masks"])
                self.assertIn("input", feed)
                return [self.output[k] for k in names]

        self.instance(0, 0, 0.9, ink=True)
        self.instance(1, 3, 0.9)
        with patch.object(app, "koharu", Session()), patch.object(app, "image_input", return_value=np.zeros((1,), np.float32)):
            result = app.run_layout(Image.new("RGB", (100, 500), "white"))
        self.assertEqual(result["panels"], [])
        self.assertEqual(result["balloons"], [])
        self.assertIn("Tiled", result["panelSkipped"])
        self.assertTrue(result["maskImage"].all())
        self.assertTrue(result["boxes"])


async def post_page(query=""):
    source = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(source, format="PNG")
    messages = []

    async def receive():
        return {"type": "http.request", "body": source.getvalue(), "more_body": False}

    async def send(message):
        messages.append(message)

    await app.app({"type": "http", "asgi": {"version": "3.0"}, "method": "POST", "scheme": "http",
                   "path": "/v1/page", "query_string": query.encode(), "headers": [],
                   "server": ("test", 80), "client": ("test", 1234)}, receive, send)
    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
    return status, json.loads(body)


class CloudLayoutAPI(unittest.IsolatedAsyncioTestCase):
    async def test_default_koharu_preserves_geometry_ocr_and_cleanup_indices(self):
        boxes = [{"x1": 10, "y1": 20, "x2": 30, "y2": 60, "conf": 0.9},
                 {"x1": 60, "y1": 20, "x2": 80, "y2": 60, "conf": 0.8}]
        panels = [{"x1": 0, "y1": 0, "x2": 100, "y2": 100, "conf": 0.9}]
        balloons = [{"width": 100, "height": 100, "x1": 10, "y1": 20, "x2": 30, "y2": 21,
                     "conf": 0.9, "rows": [[10, 30]]}]
        raw = np.zeros((100, 100), bool)
        raw[30, 15:25] = True
        detection = {"boxes": boxes, "panels": panels, "balloons": balloons, "inferMs": 1,
                     "mask": {"w": 1, "h": 1, "b64": "AA=="}, "maskImage": raw}
        patches = [{"i": 0, "png": "first"}, {"i": 1, "png": "second"}]
        with patch.object(app, "koharu", object()), patch.object(app, "run_layout", return_value=detection) as detect, \
                patch.object(app, "run_baberu", side_effect=[("first", 1), ("second", 1)]), \
                patch.object(app, "run_inpaint", return_value=(patches, 2, 1, 0)) as cleanup:
            status, wire = await post_page("inpaint=1&text_conf=0.4&panel_conf=0.6")
        self.assertEqual(status, 200)
        self.assertEqual(detect.call_args.args[1], "koharu")
        self.assertEqual(detect.call_args.args[4], {"text": 0.4, "sfx": 0.2, "bubble": 0.5, "panel": 0.6})
        self.assertEqual(wire["layoutModel"], "koharu")
        self.assertEqual(wire["layoutRecipe"], manifest.KOHARU_RECIPE)
        self.assertEqual(wire["modelSha256"], manifest.KOHARU_SHA256)
        self.assertEqual(wire["panels"], panels)
        self.assertEqual(wire["balloons"], balloons)
        self.assertEqual(wire["texts"], ["first", "second"])
        self.assertEqual(wire["patches"], patches)
        self.assertTrue(cleanup.call_args.args[3][26, 20])
        self.assertFalse(cleanup.call_args.args[3][80, 80])

    async def test_explicit_ctd_still_uses_its_existing_detector_and_skips_ocr(self):
        result = ([], 1, {"w": 1, "h": 1, "b64": "AA=="}, np.zeros((100, 100), bool))
        with patch.object(app, "ctd", object()), patch.object(app, "run_detect", return_value=result) as detect, \
                patch.object(app, "run_baberu") as ocr:
            status, wire = await post_page("layout_model=ctd&texts=0")
        self.assertEqual(status, 200)
        self.assertEqual(detect.call_args.args[1:], (0.35, 12))
        self.assertEqual(wire["layoutModel"], "ctd")
        self.assertEqual(wire["panels"], [])
        ocr.assert_not_called()

    async def test_unknown_models_and_invalid_thresholds_fail_before_inference(self):
        with patch.object(app, "run_layout") as detect:
            for query in ["layout_model=other", "text_conf=nan", "sfx_conf=0", "panel_conf=1.1"]:
                status, _ = await post_page(query)
                self.assertEqual(status, 422, query)
        detect.assert_not_called()

    async def test_missing_koharu_never_falls_back_to_loaded_ctd(self):
        with patch.object(app, "koharu", None), patch.object(app, "ctd", object()), patch.object(app, "run_detect") as ctd:
            status, wire = await post_page("texts=0")
        self.assertEqual(status, 503)
        self.assertIn("koharu", wire["error"])
        ctd.assert_not_called()


class KoharuDistribution(unittest.TestCase):
    def test_cleanup_without_a_supplied_mask_uses_default_layout_not_hidden_ctd(self):
        class Cleanup:
            def run(self, names, feed):
                return [np.zeros((1, 3, 512, 512), np.float32)]

        image = Image.new("RGB", (40, 40), "white")
        raw = np.zeros((40, 40), bool)
        raw[20, 15:25] = True
        boxes = [{"x1": 10, "y1": 10, "x2": 30, "y2": 30, "conf": 1}]
        with patch.object(app, "inpaint", Cleanup()), patch.object(app, "infer_once") as ctd, \
                patch.object(app, "run_layout", return_value={"maskImage": raw, "inferMs": 7}) as layout:
            patches, windows, _, detect_ms = app.run_inpaint(image, boxes, 0.5)
        layout.assert_called_once_with(image)
        ctd.assert_not_called()
        self.assertEqual((windows, detect_ms, len(patches)), (1, 7, 1))

    def test_model_identity_matches_extension_artifact_metadata(self):
        root = Path(__file__).resolve().parent.parent
        metadata = json.loads((root / "docs/model-mirror/koharu-fp32-chunked.json").read_text())
        self.assertEqual(manifest.KOHARU_FILE, metadata["file"])
        self.assertEqual(manifest.KOHARU_BYTES, metadata["bytes"])
        self.assertEqual(manifest.KOHARU_SHA256, metadata["sha256"])
        extension = (root / "src/layout-model.ts").read_text()
        self.assertIn(manifest.KOHARU_RECIPE, extension)
        self.assertIn(manifest.KOHARU_SHA256, extension)

    def test_model_validation_checks_size_and_sha_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"fixture")
            with self.assertRaisesRegex(RuntimeError, "size"):
                koharu.validate_model(path)
            with patch.object(koharu, "KOHARU_BYTES", 7):
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    koharu.validate_model(path)
                with patch.object(koharu, "KOHARU_SHA256", hashlib.sha256(b"fixture").hexdigest()):
                    self.assertEqual(koharu.validate_model(path), path)

    def test_notebooks_embed_current_server_modules_and_model_download(self):
        server = Path(__file__).resolve().parent
        for name in ["cloud-setup.ipynb", "colab-server.ipynb"]:
            notebook = json.loads((server / name).read_text())
            cells = ["".join(cell["source"]) for cell in notebook["cells"]]
            for module in ["app.py", "koharu.py", "models_manifest.py", "split.py", "balloon_surface.py"]:
                embedded = next(cell for cell in cells if cell.startswith("%%writefile " + module + "\n"))
                self.assertEqual(embedded.split("\n", 1)[1], (server / module).read_text())
            self.assertIn(manifest.KOHARU_FILE, "\n".join(cells))
