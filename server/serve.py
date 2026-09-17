# Standalone launcher for platforms with no wrapper of their own (Colab's own
# GPU — server/colab-server.ipynb — or any VPS). Modal keeps modal_app.py.
# Same Bearer rule either way: ARN_API_KEY set = auth on, / and /health stay
# open (the extension reads /health for Test/warm), everything else 401s.
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
