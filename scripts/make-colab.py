#!/usr/bin/env python3
# Generates both deploy notebooks from the live server sources — the
# notebooks are build artifacts (single source of truth stays in server/).
#   cloud-setup.ipynb  — deploy the server to Modal (stable URL, account)
#   colab-server.ipynb — run the server IN Colab (free T4, cloudflared URL)
# Both let a normal user (browser only, no terminal) end up with the two
# values the extension needs: endpoint URL + API key.
import json
import os
import re
import sys
import textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODAL_VERSION = "1.5.5"  # pinned: this is the client the deploy was proven with

sys.path.insert(0, os.path.join(ROOT, "server"))
from models_manifest import CTD_URL, BABERU, BABERU_FILES  # noqa: E402


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


modal_nb = {"nbformat": 4, "nbformat_minor": 5,
      "metadata": {"kernelspec": {"display_name": "Python 3",
                                  "language": "python", "name": "python3"}},
      "cells": [
    md([
        "# Run your own translation server (Modal, stable URL)\n",
        "\n",
        "This deploys the translator's server to your own Modal account — the URL\n",
        "stays the same, so you paste it into the extension once. Click Runtime →\n",
        "Run all, then paste the two values printed at the end.\n",
        "\n",
        "- **Cost:** Modal Starter is free — $30/month of compute (~50 T4-hours),\n",
        "  no card needed to start. A reading session costs minutes.\n",
        "- **Idle:** it scales to zero; the first page after a break waits\n",
        "  ~1-2 min to wake up.\n",
        "- **No Modal account?** `colab-server.ipynb` runs the same server on\n",
        "  Colab's free GPU instead (URL changes every session).\n",
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
    writefile_cell("models_manifest.py", read("models_manifest.py")),
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
        "## 5. Test the endpoint\n",
        "\n",
        "Checks the GPU placement, then sends one small image through your\n",
        "server.\n",
    ]),
    code([
        "import io, json, urllib.request\n",
        "assert 'ENDPOINT' in dir() and 'API_KEY' in dir(), 'run Step 4 first'\n",
        "from PIL import Image  # preinstalled on Colab\n",
        "img = Image.new('L', (64, 64), 128)\n",
        "buf = io.BytesIO()\n",
        'img.save(buf, "JPEG")\n',
        "# /health is auth-exempt; `device` only echoes the requested device, so\n",
        "# check `ep` for the provider that actually loaded\n",
        'with urllib.request.urlopen(ENDPOINT + "/health", timeout=300) as r:\n',
        "    h = json.load(r)\n",
        "eps = h.get('ep') or {}\n",
        'print("device=%s ep=%s" % (h.get("device"), eps))\n',
        "if not any('CUDAExecutionProvider' in v for v in eps.values()):\n",
        '    print("! CUDA is not active — this endpoint is on CPU (much slower).")\n',
        '    print("  Re-deploy and check `modal app logs`; the image pins CUDA 13 + onnxruntime-gpu 1.30.")\n',
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
        "- **Endpoint answers but pages are very slow:** `ep` in Step 5 showed no\n",
        "  `CUDAExecutionProvider` — the deploy fell back to CPU; check\n",
        "  `modal app logs` and re-deploy.\n",
        "- **To update later:** Runtime → Run all again. The address stays the same;\n",
        "  paste the new API key into the extension.\n",
        f"- **To delete everything:** run `!modal app stop {APP_NAME}` in a new cell,\n",
        f"  then delete the `{SECRET_NAME}` secret on the Modal dashboard.\n",
    ]),
]}

def md_text(text):
    return md([l + "\n" for l in textwrap.dedent(text).strip("\n").splitlines()])


def code_text(text):
    return code([l + "\n" for l in textwrap.dedent(text).strip("\n").splitlines()])


# ---- colab-server.ipynb: run the server on Colab's own GPU ----------------
# cloudflared quick tunnel = public https URL, no account needed; the URL is
# new every session and dies with the VM — the notebook says so where it
# matters.
_models = [("ctd.onnx", CTD_URL)] + [(dst, f"{BABERU}/{src}?download=true")
                                    for src, dst in BABERU_FILES]
_FILES = textwrap.indent("FILES = [\n" + "".join(
    f"    ({json.dumps(n)}, {json.dumps(u)}),\n" for n, u in _models) + "]", " " * 8)

colab_nb = {"nbformat": 4, "nbformat_minor": 5,
            "metadata": {"kernelspec": {"display_name": "Python 3",
                                        "language": "python", "name": "python3"}},
            "cells": [
    md_text("""
        # Run the translation server here, on this Colab GPU

        This runs the translator's detection + OCR inside this notebook's VM
        (a free T4 GPU needs only a Google sign-in — no card, no other
        account) and opens a Cloudflare quick tunnel so the extension can
        reach it.

        Click **Runtime → Run all**, wait for the banner at the end, then paste
        the two printed values into the extension (Options → Model → Where
        detection runs → Cloud) and press **Test cloud & prewarm**.

        Keep in mind:

        - **Keep this tab open.** Colab reclaims the VM after ~90 minutes
          without tab activity, and a session ends by ~12 hours regardless.
        - **The URL changes every session.** After a reconnect, run the cells
          again and paste the new URL into the extension.
        - **Free T4s come from a shared quota** — not guaranteed. No GPU this
          time? Runtime → Change runtime type → T4 GPU, then Run all again;
          CPU still works, just much slower.
        - Colab's free tier is for interactive use: fine while you read with
          the tab open, not for an unattended server.
    """),
    md_text("""
        ## 0. Check the GPU
    """),
    code_text("""
        import shutil, subprocess
        if shutil.which("nvidia-smi"):
            r = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True)
            print((r.stdout or r.stderr).strip()[:400])
            if r.returncode != 0 or "GPU" not in r.stdout:
                print("! GPU not visible to nvidia-smi — Runtime → Change runtime type → T4 GPU, then Run all again")
        else:
            print("! no GPU runtime (nvidia-smi missing) — Runtime → Change runtime type → T4 GPU, then Run all again. Continuing on CPU.")
    """),
    md_text("""
        ## 1. Install

        Installs the inference stack here (a minute or two).
    """),
    code_text("""
        %pip uninstall -q -y onnxruntime
        # pinned: 1.30+ wheels need CUDA 13, Colab's T4 image ships CUDA 12.8
        %pip install -q "onnxruntime-gpu==1.22.0" fastapi "uvicorn[standard]" pillow opencv-python-headless numpy
        import onnxruntime
        print("onnxruntime", onnxruntime.__version__, "| providers:", onnxruntime.get_available_providers())
    """),
    md_text("""
        ## 2. Save the server files

        Copies the server code here. Just run both cells.
    """),
    writefile_cell("app.py", read("app.py")),
    writefile_cell("serve.py", read("serve.py")),
    md_text("""
        ## 3. Download the models (~230MB)

        Fetched fresh every session (the VM is wiped between sessions) and
        skipped when the files are already here.
    """),
    code_text(_FILES + """
        import os, subprocess
        MODEL_DIR = "/content/models"
        os.makedirs(MODEL_DIR, exist_ok=True)
        for name, url in FILES:
            dest = os.path.join(MODEL_DIR, name)
            if os.path.isfile(dest) and os.path.getsize(dest) > 0:
                print("have", name)
                continue
            part = dest + ".part"
            r = subprocess.run(["curl", "-fL", "--retry", "3", "--retry-all-errors", "-o", part, url])
            assert r.returncode == 0, f"download failed: {name}"
            os.replace(part, dest)
            print("got", name, str(os.path.getsize(dest) // 1048576) + "MB")
        print("models ready in", MODEL_DIR)
    """),
    md_text("""
        ## 4. Start the server

        Loads the models onto the GPU (tens of seconds on a T4) and keeps the
        server running in the background. Re-running this cell is safe — it
        reuses a server that is already up. The API key is saved to
        `/content/api_key.txt` so re-runs keep the same one.
    """),
    code_text("""
        import glob, json, os, secrets, subprocess, sys, time, urllib.request

        PORT = 7860
        keyfile = "/content/api_key.txt"
        if os.path.isfile(keyfile):
            API_KEY = open(keyfile).read().strip()
        else:
            API_KEY = secrets.token_hex(32)
            open(keyfile, "w").write(API_KEY)

        # Colab ships CUDA/cuDNN as pip packages under site-packages/nvidia —
        # the loader needs those dirs on its path for ORT's CUDA provider
        cuda_libs = sorted(set(
            glob.glob("/usr/local/lib/python*/dist-packages/nvidia/*/lib")
            + glob.glob("/usr/local/lib/python*/site-packages/nvidia/*/lib")))

        def health():
            try:
                with urllib.request.urlopen("http://127.0.0.1:" + str(PORT) + "/health", timeout=5) as r:
                    return json.load(r)
            except Exception:
                return None

        if health() is None:
            env = dict(os.environ, MODEL_DIR="/content/models", ARN_API_KEY=API_KEY, PORT=str(PORT),
                       ORT_PROVIDERS="CUDAExecutionProvider,CPUExecutionProvider", ORT_DEVICE="cuda",
                       LD_LIBRARY_PATH=":".join(cuda_libs + [os.environ.get("LD_LIBRARY_PATH", "")]))
            log = open("/content/server.log", "w")
            proc = subprocess.Popen([sys.executable, "serve.py"], env=env,
                                    stdout=log, stderr=subprocess.STDOUT)
            t0 = time.time()
            while time.time() - t0 < 240 and health() is None:
                if proc.poll() is not None:
                    print(open("/content/server.log").read()[-3000:])
                    raise SystemExit("server exited — see log above")
                time.sleep(2)
            assert health() is not None, "server did not come up in 240s — see /content/server.log"
        h = health()
        eps = h.get("ep") or {}
        print("✓ server up — ep=%s" % eps)
        if not any("CUDAExecutionProvider" in v for v in eps.values()):
            print("! CUDA is not active (CPU only) — pages will be very slow. Re-run the install cell, or Runtime → Change runtime type → T4 GPU.")
    """),
    md_text("""
        ## 5. Open the tunnel

        Cloudflare quick tunnel — no account needed. The URL is new every time
        you run this cell; the old ones keep working until the session ends.
    """),
    code_text(r"""
        import os, re, subprocess, time
        BIN = "/content/cloudflared"
        if not os.path.isfile(BIN):
            r = subprocess.run(["curl", "-fL", "--retry", "3", "-o", BIN,
                                "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"])
            assert r.returncode == 0, "cloudflared download failed"
            os.chmod(BIN, 0o755)

        LOG = "/content/tunnel.log"
        with open(LOG, "w") as log:
            proc = subprocess.Popen([BIN, "tunnel", "--url", "http://127.0.0.1:" + str(PORT), "--no-autoupdate"],
                                    stdout=log, stderr=subprocess.STDOUT)
        t0 = time.time()
        while time.time() - t0 < 45:
            time.sleep(2)
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", open(LOG).read())
            if m:
                ENDPOINT = m.group(0)
                break
            if proc.poll() is not None:
                print(open(LOG).read()[-3000:])
                raise SystemExit("cloudflared exited — see log above")
        assert "ENDPOINT" in dir(), "no tunnel URL in 45s — see /content/tunnel.log"
        print("✓ tunnel:", ENDPOINT)
    """),
    md_text("""
        ## 6. Test through the tunnel

        Sends one tiny image through the public URL and prints the two values
        for the extension.
    """),
    code_text("""
        import io, json, time, urllib.error, urllib.request
        from PIL import Image

        img = Image.new("L", (64, 64), 128)
        buf = io.BytesIO()
        img.save(buf, "JPEG")
        blob = buf.getvalue()

        def post(headers, timeout):
            req = urllib.request.Request(ENDPOINT + "/v1/page", data=blob, headers=headers)
            return urllib.request.urlopen(req, timeout=timeout)

        # a fresh quick-tunnel hostname can lag in the VM's resolver — retry
        # before calling it broken (the URL is public, so the API key is the
        # only gate: verify it is enforced on the way)
        res = None
        for attempt in range(8):
            try:
                try:
                    post({}, 30)
                    raise SystemExit("auth is NOT enforced — check ARN_API_KEY / serve.py")
                except urllib.error.HTTPError as e:
                    assert e.code == 401, "expected 401 without a key, got %s" % e.code
                with post({"Authorization": "Bearer " + API_KEY,
                           "Content-Type": "image/jpeg"}, 180) as r:
                    res = json.load(r)
                break
            except urllib.error.URLError as e:
                print("tunnel not resolvable yet (attempt %d): %s" % (attempt + 1, e))
                time.sleep(6)

        if res is None:
            print("! could not reach the endpoint from inside this VM — external clients")
            print("  usually still work; try the extension's Test button first.")
        else:
            assert res.get("ok") and "boxes" in res, res
            print("✓ endpoint answers through the tunnel: %dx%d, %d boxes, %.0fms total"
                  % (res["w"], res["h"], len(res["boxes"]), res["ms"]["total"]))
        print("=" * 60)
        print("ENDPOINT:", ENDPOINT)
        print("API KEY :", API_KEY)
        print("=" * 60)
        print("Paste both into the extension: Options → Model → Where detection runs → Cloud,")
        print("then press Test cloud & prewarm. Keep this tab open while you read.")
    """),
    md_text("""
        ## If something goes wrong

        - **Server log / crash:** `open('/content/server.log').read()[-2000:]`
          in a new cell.
        - **Tunnel log:** same with `/content/tunnel.log`.
        - **Colab disconnected / VM died:** Runtime → Reconnect (or Run all
          again) — the models re-download, the tunnel prints a NEW url; paste
          it into the extension.
        - **The extension says the request failed:** re-run from step 4 down,
          check the endpoint URL matches the last banner, and press Test cloud
          & prewarm in the extension options.
        - **Very slow pages:** `ep` at step 4 showed only
          `CPUExecutionProvider` — the pinned `onnxruntime-gpu` wheel did not
          match the runtime's CUDA. Re-run the install cell, then re-run step
          4 down.
        - **Want a stable URL instead?** Deploy with `cloud-setup.ipynb`
          (Modal).
    """),
]}


def write_nb(name, nb):
    dest = os.path.join(ROOT, "server", name)
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(nb, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("wrote", dest)


write_nb("cloud-setup.ipynb", modal_nb)
write_nb("colab-server.ipynb", colab_nb)
