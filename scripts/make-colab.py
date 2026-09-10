#!/usr/bin/env python3
# Generates server/cloud-setup.ipynb from the live server sources — the
# notebook is a build artifact (single source of truth stays in server/).
# The notebook lets a normal user (browser only, no terminal) deploy their
# OWN endpoint: fill 2 secrets -> Run all -> paste 2 printed values
# into the extension options. Bill/quota are theirs, no shared secrets.
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODAL_VERSION = "1.5.5"  # pinned: this is the client the deploy was proven with


def read(name):
    with open(os.path.join(ROOT, "server", name), encoding="utf-8") as f:
        return f.read()


# App + secret names live in modal_app.py only — the notebook derives them so
# a rename touches exactly one file.
_modal_src = read("modal_app.py")
APP_NAME = re.search(r'modal\.App\("([^"]+)"', _modal_src).group(1)
SECRET_NAME = re.search(r'from_name\("([^"]+)"', _modal_src).group(1)
# Modal web URL = {workspace}--{app}-{function}.modal.run — the function name
# ("api") lands as a suffix, so tolerate it instead of anchoring at the app name.
URL_RE = (r"https://[a-z0-9-]+--" + re.escape(APP_NAME)
          + r"(?:-[a-z0-9-]+)?\.modal\.run")


def md(lines):
    return {"cell_type": "markdown", "metadata": {}, "source": lines}


def code(lines):
    return {"cell_type": "code", "metadata": {},
            "execution_count": None, "outputs": [], "source": lines}


def writefile_cell(name, content):
    # %%writefile avoids every quoting problem the 400-line app.py would cause
    return code(["%%writefile " + name + "\n"] + [l + "\n" for l in content.splitlines()])


nb = {"nbformat": 4, "nbformat_minor": 5,
      "metadata": {"kernelspec": {"display_name": "Python 3",
                                  "language": "python", "name": "python3"}},
      "cells": [
    md([
        "# Run your own translation server\n",
        "\n",
        "This runs the translator's server on your Modal account (free monthly\n",
        "credit — Modal unlocks the full amount once you add a card).\n",
        "Click Runtime → Run all, then paste the two values printed at the end into\n",
        "the extension.\n",
        "\n",
        "Before you start:\n",
        "\n",
        "1. Create a free account at [modal.com](https://modal.com).\n",
        "2. In Modal: Settings → API tokens → create a token.\n",
        "3. On this page: click 🔑 Secrets (left sidebar) and add `MODAL_TOKEN_ID`\n",
        "   and `MODAL_TOKEN_SECRET` with the two values.\n",
    ]),
    md([
        "## 1. Install\n",
        "\n",
        "Installs the Modal tool and the packages the deploy reads. Takes a minute or two.\n",
    ]),
    code([
        f'%pip install -q modal=={MODAL_VERSION} fastapi "uvicorn[standard]" onnxruntime numpy pillow opencv-python-headless\n',
        "import shutil\n",
        'assert shutil.which("modal"), "modal CLI not found after install — re-run this cell"\n',
        'print("✓ ready")\n',
    ]),
    md([
        "## 2. Log in\n",
        "\n",
        "Uses the two 🔑 Secrets from the left sidebar. Values are checked\n",
        "before anything runs.\n",
    ]),
    code([
        "import os, subprocess\n",
        "try:\n",
        "    from google.colab import userdata  # type: ignore  # Colab only\n",
        "    def _get(k):\n",
        "        try:\n",
        "            return userdata.get(k)\n",
        "        except Exception:\n",
        '            return ""\n',
        "except ImportError:  # local Jupyter fallback — typed, never saved\n",
        "    import getpass\n",
        "    def _get(k):\n",
        '        return getpass.getpass(k + ": ")\n',
        'tid = (_get("MODAL_TOKEN_ID") or "").strip()\n',
        'tsec = (_get("MODAL_TOKEN_SECRET") or "").strip()\n',
        "if not tid or not tsec:\n",
        '    raise SystemExit("✗ add both values to the 🔑 Secrets sidebar (exact names "\n',
        '                     "MODAL_TOKEN_ID / MODAL_TOKEN_SECRET), then re-run this cell")\n',
        "if not tid.startswith(\"ak-\"):\n",
        "    raise SystemExit('✗ MODAL_TOKEN_ID should start with \"ak-\" — check the values')\n",
        "if not tsec.startswith(\"as-\"):\n",
        "    raise SystemExit('✗ MODAL_TOKEN_SECRET should start with \"as-\" — check the values')\n",
        'os.environ["MODAL_TOKEN_ID"] = tid\n',
        'os.environ["MODAL_TOKEN_SECRET"] = tsec\n',
        'r = subprocess.run(["modal", "token", "info"], capture_output=True, text=True)\n',
        "if r.returncode != 0:\n",
        '    raise SystemExit("✗ Modal rejected the token — it may be revoked; create a new one "\n',
        '                     "(Modal dashboard → Settings → API tokens), then re-run this cell.\\n"\n',
        "                     + r.stderr[-500:])\n",
        'print("✓ Authenticated:")\n',
        "print(r.stdout.strip()[-500:] or '(ok)')\n",
    ]),
    md([
        "## 3. Save the server files\n",
        "\n",
        "Copies the server code here. Just run both cells.\n",
    ]),
    writefile_cell("modal_app.py", read("modal_app.py")),
    writefile_cell("app.py", read("app.py")),
    md([
        "## 4. Deploy\n",
        "\n",
        "First run takes a few minutes. The two values for the extension print\n",
        "at the end. Run it again to update — the old API key stops working,\n",
        "paste the new one.\n",
    ]),
    code([
        "import pathlib, re, secrets, subprocess\n",
        'assert pathlib.Path("modal_app.py").exists() and pathlib.Path("app.py").exists(), \\\n',
        '    "server files missing — re-run Step 3"\n',
        "API_KEY = secrets.token_hex(32)\n",
        f'subprocess.run(["modal", "secret", "create", "--force", "{SECRET_NAME}",\n',
        '                f"ARN_API_KEY={API_KEY}"], check=True)\n',
        'out = subprocess.run(["modal", "deploy", "modal_app.py"],\n',
        '                     capture_output=True, text=True)\n',
        'out = (out.stdout + "\\n" + out.stderr).strip() + "\\n"\n',
        "print(out[-1500:])\n",
        f'm = re.search(r"{URL_RE}", out)\n',
        "if not m:\n",
        '    raise SystemExit("✗ deploy output has no endpoint URL — read the log above, "\n',
        '                     "fix, then re-run this cell")\n',
        "ENDPOINT = m.group(0)\n",
        'print("=" * 60)\n',
        'print("ENDPOINT:", ENDPOINT)\n',
        'print("API KEY:", API_KEY)\n',
        'print("=" * 60)\n',
    ]),
    md([
        "## 5. Test\n",
        "\n",
        "Sends one small image through your server to confirm it answers.\n",
    ]),
    code([
        "import io, json, urllib.request\n",
        "assert 'ENDPOINT' in dir() and 'API_KEY' in dir(), 'run Step 4 first'\n",
        "from PIL import Image  # preinstalled on Colab\n",
        "img = Image.new('L', (64, 64), 128)\n",
        "buf = io.BytesIO()\n",
        'img.save(buf, "JPEG")\n',
        "req = urllib.request.Request(\n",
        '    ENDPOINT + "/v1/page", data=buf.getvalue(),\n',
        '    headers={"Authorization": "Bearer " + API_KEY, "Content-Type": "image/jpeg"})\n',
        "# first request may cold-start the GPU container (~1-2 min) — be patient\n",
        "with urllib.request.urlopen(req, timeout=300) as r:\n",
        "    res = json.load(r)\n",
        'assert res.get("ok") and "boxes" in res, res\n',
        "print(f\"✓ Endpoint is live: {res['w']}x{res['h']}, \"\n",
        "      f\"{len(res['boxes'])} boxes, {res['ms']['total']}ms total\")\n",
        'print("=" * 60)\n',
        'print("ENDPOINT:", ENDPOINT)\n',
        'print("API KEY:", API_KEY)\n',
        'print("=" * 60)\n',
        'print("Paste both into the extension: Options → Model → Where detection runs → Cloud,")\n',
        'print("then press Test cloud & prewarm.")\n',
        'print("You can now close this tab — the endpoint stays up on Modal.")\n',
    ]),
    md([
        "## If something goes wrong\n",
        "\n",
        "- **Step 2 fails:** a 🔑 Secret is missing, misnamed, swapped, or revoked.\n",
        "  Fix it, then Runtime → Run all again.\n",
        "- **Step 4 seems stuck:** normal the first time (a few minutes). Wait.\n",
        "- **To update later:** Runtime → Run all again. The address stays the same;\n",
        "  paste the new API key into the extension.\n",
        f"- **To delete everything:** run `!modal app stop {APP_NAME}` in a new cell,\n",
        f"  then delete the `{SECRET_NAME}` secret on the Modal dashboard.\n",
    ]),
]}

dest = os.path.join(ROOT, "server", "cloud-setup.ipynb")
with open(dest, "w", encoding="utf-8") as f:
    json.dump(nb, f, indent=1, ensure_ascii=False)
    f.write("\n")
print("wrote", dest)
