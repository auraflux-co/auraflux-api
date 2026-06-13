"""HTTP front door for EchoMimic on a dedicated RunPod GPU pod (CPD-990).

POST /run       — enqueue render; returns immediately with job_id (avoids CF 120s timeout)
GET  /status/X  — poll job result
GET  /health    — liveness
"""

import json
import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

from handler import handler

PORT = int(os.environ.get('ECHOMIMIC_HTTP_PORT', '8000'))
JOBS_DIR = '/tmp/echomimic_jobs'
os.makedirs(JOBS_DIR, exist_ok=True)

_jobs_lock = threading.Lock()


def _job_path(job_id):
    return os.path.join(JOBS_DIR, f'{job_id}.json')


def _write_job(job_id, data):
    with _jobs_lock:
        with open(_job_path(job_id), 'w') as f:
            json.dump(data, f)


def _read_job(job_id):
    path = _job_path(job_id)
    if not os.path.isfile(path):
        return None
    with _jobs_lock:
        with open(path) as f:
            return json.load(f)


def _run_job(job_id, inp):
    _write_job(job_id, {'status': 'running', 'started_at': time.time()})
    try:
        result = handler({'input': inp})
        _write_job(job_id, {
            'status': 'completed' if result.get('ok') else 'failed',
            'result': result,
            'finished_at': time.time()
        })
    except Exception as e:
        _write_job(job_id, {
            'status': 'failed',
            'result': {'ok': False, 'error': f'{type(e).__name__}: {e}'},
            'finished_at': time.time()
        })


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[http] {self.address_string()} {fmt % args}")

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ('/health', '/'):
            self._json(200, {'ok': True, 'service': 'echomimic-http'})
            return
        if self.path.startswith('/status/'):
            job_id = self.path.split('/status/', 1)[1].split('?', 1)[0]
            job = _read_job(job_id)
            if not job:
                self._json(404, {'ok': False, 'error': 'unknown job_id'})
                return
            self._json(200, {'ok': True, 'job_id': job_id, **job})
            return
        self._json(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if self.path not in ('/run', '/'):
            self._json(404, {'ok': False, 'error': 'not found'})
            return
        n = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(n) if n else b'{}'
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._json(400, {'ok': False, 'error': 'invalid json'})
            return
        inp = payload.get('input') if isinstance(payload.get('input'), dict) else payload
        job_id = uuid.uuid4().hex[:12]
        _write_job(job_id, {'status': 'queued'})
        threading.Thread(target=_run_job, args=(job_id, inp), daemon=True).start()
        self._json(202, {'ok': True, 'job_id': job_id, 'status': 'queued'})


if __name__ == '__main__':
    srv = HTTPServer(('0.0.0.0', PORT), _Handler)
    print(f'[http] echomimic async listening on :{PORT}')
    srv.serve_forever()
