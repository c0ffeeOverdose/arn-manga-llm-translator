# Standalone launcher for platforms with no wrapper of their own (Colab's own
# GPU — server/colab-server.ipynb — or any VPS). Modal keeps modal_app.py.
# ARN_API_KEY enables standalone Bearer auth except on / and /health.
# Modal instead authenticates every path at its proxy, before GPU allocation.
import os

from app import app

KEY = os.environ.get("ARN_API_KEY", "")

if KEY:
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import JSONResponse

    class Auth(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            if request.url.path in ("/", "/health"):
                return await call_next(request)
            if request.headers.get("authorization") != f"Bearer {KEY}":
                return JSONResponse({"ok": False, "error": "unauthorized"}, 401)
            return await call_next(request)

    app.add_middleware(Auth)
else:
    print("serve: ARN_API_KEY not set — running WITHOUT auth (local/testing only)",
          flush=True)

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "7860")))
