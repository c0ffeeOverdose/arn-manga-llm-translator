import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.parse
import urllib.request


SERVER = Path(__file__).resolve().parent
TOKEN_ID = "wk-fixture"
TOKEN_SECRET = "ws-fixture"
API_KEY = f"{TOKEN_ID}.{TOKEN_SECRET}"
ENDPOINT = "https://workspace--arn-manga-api.modal.run"


class ImageStub:
    def __getattr__(self, name):
        return lambda *args, **kwargs: self


class ModalDeployment(unittest.TestCase):
    def setUp(self):
        self.config = {}
        self.fastapi = object()

        def function(**kwargs):
            self.config.update(kwargs)
            return lambda fn: fn

        def asgi_app(**kwargs):
            self.proxy_auth = kwargs.get("requires_proxy_auth", False)
            return lambda fn: fn

        modal = SimpleNamespace(Image=SimpleNamespace(from_registry=lambda *args, **kwargs: ImageStub()),
                                App=lambda *args: SimpleNamespace(function=function), asgi_app=asgi_app,
                                Secret=SimpleNamespace(from_name=lambda name: name))
        with patch.dict(sys.modules, {"modal": modal, "app": SimpleNamespace(app=self.fastapi)}), \
                patch.object(sys, "path", list(sys.path)):
            self.module = runpy.run_path(str(SERVER / "modal_app.py"))

    def test_every_route_requires_modal_proxy_auth(self):
        self.assertTrue(self.proxy_auth)

    def test_gpu_scale_has_an_explicit_single_container_cap(self):
        self.assertEqual(self.config.get("max_containers"), 1)
        self.assertEqual(self.config.get("min_containers", 0), 0)

    def test_app_needs_no_second_in_container_credential(self):
        self.assertNotIn("secrets", self.config)
        self.assertIs(self.module["api"](), self.fastapi)


def notebook_cell(heading):
    notebook = json.loads((SERVER / "cloud-setup.ipynb").read_text())
    active = False
    for cell in notebook["cells"]:
        source = "".join(cell["source"])
        if cell["cell_type"] == "markdown":
            active = source.startswith(heading)
        elif active:
            return source
    raise AssertionError(f"missing notebook cell: {heading}")


class InvalidError(Exception):
    pass


class ModalNotebook(unittest.TestCase):
    def setUp(self):
        self.tokens = SimpleNamespace(create=Mock(return_value=SimpleNamespace(token_id=TOKEN_ID, token_secret=TOKEN_SECRET)),
                                      allow=Mock())
        self.workspace = SimpleNamespace(proxy_tokens=self.tokens,
                                         settings=SimpleNamespace(list=lambda: SimpleNamespace(default_environment="reader-env")))
        self.modal = SimpleNamespace(Workspace=SimpleNamespace(from_context=lambda: self.workspace),
                                     exception=SimpleNamespace(InvalidError=InvalidError))

    def run_deploy(self, stdout, environment="", returncode=0):
        result = SimpleNamespace(returncode=returncode, stdout=f"Deployed {ENDPOINT}", stderr="")
        with patch.dict(sys.modules, {"modal": self.modal}), patch("pathlib.Path.exists", return_value=True), \
                patch.dict(os.environ, {"MODAL_ENVIRONMENT": environment}), \
                patch("subprocess.run", return_value=result) as command, contextlib.redirect_stdout(stdout):
            scope = {}
            exec(notebook_cell("## 4. Deploy"), scope)
        return scope, command

    def test_rbac_workspace_scopes_the_new_token_to_the_deployment_environment(self):
        for environment in ["", "custom-env"]:
            with self.subTest(environment=environment):
                out = io.StringIO()
                scope, command = self.run_deploy(out, environment)
                expected = environment or "reader-env"
                self.assertEqual(scope["API_KEY"], API_KEY)
                self.tokens.allow.assert_called_with(TOKEN_ID, expected)
                self.assertIn(f"scoped to environment {expected}", out.getvalue())
                args = command.call_args.args[0]
                self.assertEqual(args[:5], ["modal", "deploy", "modal_app.py", "--env", expected])
                self.assertFalse(any(call.args[0][1:2] == ["secret"] for call in command.call_args_list))

    def test_workspace_wide_tokens_skip_scoping_without_failing(self):
        self.tokens.allow.side_effect = InvalidError("Token is not environment-scoped")
        out = io.StringIO()
        scope, _ = self.run_deploy(out)
        self.assertEqual(scope["API_KEY"], API_KEY)
        self.tokens.allow.assert_called_with(TOKEN_ID, "reader-env")
        self.assertIn("workspace-wide", out.getvalue())
        self.assertIn(TOKEN_SECRET, out.getvalue())

    def test_unexpected_scope_failure_raises_after_the_key_is_printed(self):
        self.tokens.allow.side_effect = InvalidError("Environment 'reader-env' not found")
        out = io.StringIO()
        with self.assertRaises(InvalidError):
            self.run_deploy(out)
        self.assertIn(f"API KEY: {API_KEY}", out.getvalue())

    def test_failed_deploy_does_not_print_success_or_create_a_token(self):
        with self.assertRaises(SystemExit):
            self.run_deploy(io.StringIO(), returncode=1)
        self.tokens.create.assert_not_called()
        self.tokens.allow.assert_not_called()

    def run_probe(self, protected=True):
        requests = []

        def urlopen(request, timeout):
            if isinstance(request, str):
                request = urllib.request.Request(request)
            path = urllib.parse.urlparse(request.full_url).path
            authorization = request.get_header("Authorization")
            requests.append((path, authorization))
            if protected and authorization != f"Bearer {API_KEY}":
                raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO())
            payload = {"ok": True, "ep": {"koharu": ["CUDAExecutionProvider"]}, "splitGen": 1,
                       "w": 64, "h": 64, "boxes": [], "ms": {"total": 1}}
            return io.BytesIO(json.dumps(payload).encode())

        with patch("urllib.request.urlopen", side_effect=urlopen), contextlib.redirect_stdout(io.StringIO()):
            exec(notebook_cell("## 5. Test the endpoint"), {"ENDPOINT": ENDPOINT, "API_KEY": API_KEY})
        return requests

    def test_probe_checks_public_routes_then_authenticates_health_and_inference(self):
        requests = self.run_probe()
        for path in ["/", "/health", "/v1/page", "/v1/inpaint"]:
            self.assertIn((path, None), requests)
        self.assertIn(("/health", f"Bearer {API_KEY}"), requests)
        self.assertIn(("/v1/page", f"Bearer {API_KEY}"), requests)

    def test_probe_fails_closed_when_an_endpoint_is_unprotected(self):
        with self.assertRaises(SystemExit):
            self.run_probe(protected=False)

    def test_generated_notebook_embeds_the_current_modal_boundary(self):
        notebook = json.loads((SERVER / "cloud-setup.ipynb").read_text())
        embedded = next("".join(cell["source"]) for cell in notebook["cells"]
                        if "".join(cell["source"]).startswith("%%writefile modal_app.py\n"))
        self.assertEqual(embedded.split("\n", 1)[1], (SERVER / "modal_app.py").read_text())
