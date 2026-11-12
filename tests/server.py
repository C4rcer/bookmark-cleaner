"""Local test server for Prune's E2E test (stdlib only).

Answers on any Host name, so Firefox can reach it as site.prune.test,
other.prune.test, ... via the network.dns.localDomains pref. Every request is
logged with its method, host, path and Cookie header, and the server tracks
how many requests are in flight (overall and per host) so the test can check
the checker's concurrency limits. /slow is left out of that count: its handler
keeps sleeping after the client has given up, which would overstate it.

Routes (exact paths):
  /, /ok*, /new, /login, /docs/, /article, /article/, /page   200
  /missing 404   /gone 410   /error 500   /forbidden 403
  /slow       waits 5 s, then 200
  /nohead     HEAD -> 405, GET -> 200
  /headfail   HEAD -> 404, GET -> 200
  /old        301 -> /new
  /old-article 302 -> /            (a removed page sent to the home page)
  /private    302 -> /login?next=/private
  /docs       301 -> /docs/
  /setcookie  200 with Set-Cookie: sid=secret
  anything else 404
Query ?d=<ms> delays any response.
"""
import http.server
import threading
import time
from urllib.parse import parse_qs, urlparse

OK_PATHS = {"/", "/new", "/login", "/docs/", "/article", "/article/", "/page"}
STATUS = {"/missing": 404, "/gone": 410, "/error": 500, "/forbidden": 403}
REDIRECTS = {
    "/old": (301, "/new"),
    "/old-article": (302, "/"),
    "/private": (302, "/login?next=/private"),
    "/docs": (301, "/docs/"),
}


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.log = []  # (method, host, path, query, cookie)
        self.inflight = 0
        self.max_inflight = 0
        self.host_inflight = {}
        self.max_host = {}

    def reset_max(self):
        with self.lock:
            self.max_inflight = self.inflight
            self.max_host = dict(self.host_inflight)


STATE = State()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *a):
        pass

    def do_HEAD(self):
        self.route("HEAD")

    def do_GET(self):
        self.route("GET")

    def send(self, code, headers=None, body=b"<!doctype html><title>test</title><p>ok</p>"):
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def route(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        s = STATE
        tracked = u.path != "/slow"
        with s.lock:
            s.log.append((method, host, u.path, u.query, self.headers.get("Cookie")))
            if tracked:
                s.inflight += 1
                s.max_inflight = max(s.max_inflight, s.inflight)
                s.host_inflight[host] = s.host_inflight.get(host, 0) + 1
                s.max_host[host] = max(s.max_host.get(host, 0), s.host_inflight[host])
        try:
            if q.get("d"):
                time.sleep(int(q["d"]) / 1000)
            p = u.path
            if p in OK_PATHS or p.startswith("/ok"):
                self.send(200)
            elif p == "/setcookie":
                self.send(200, {"Set-Cookie": "sid=secret; Path=/; Max-Age=3600"})
            elif p in STATUS:
                self.send(STATUS[p])
            elif p == "/slow":
                time.sleep(5)
                self.send(200)
            elif p == "/nohead":
                self.send(405 if method == "HEAD" else 200)
            elif p == "/headfail":
                self.send(404 if method == "HEAD" else 200)
            elif p in REDIRECTS:
                code, loc = REDIRECTS[p]
                self.send(code, {"Location": loc})
            else:
                self.send(404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            if tracked:
                with s.lock:
                    s.inflight -= 1
                    s.host_inflight[host] -= 1


def start(port):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd
