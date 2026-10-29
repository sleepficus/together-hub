#!/usr/bin/env python3
"""Offline full phase protocol, real local Hub + fake loopback model answers.
Never a live model result or an actual Main participant; all identities marked TEST.
"""
import hashlib
import http.cookiejar
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    with tempfile.TemporaryDirectory(prefix='hub-demo-offline-') as tmp:
        root = Path(tmp)
        film = root / 'film'
        hits = []
        class FakeModel(BaseHTTPRequestHandler):
            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                prompt = data['messages'][0]['content']
                hits.append(prompt)
                if prompt.startswith('You are the dispatcher'):
                    target = json.loads((film / 'spark-connection.json').read_text())['identityId']
                    content = json.dumps({'action': 'deliver', 'to': target,
                                         'reason': 'OFFLINE fixture address', 'summary': 'OFFLINE TEST routing'})
                elif 'Return ONLY JSON with code' in prompt:
                    content = json.dumps({'code': 'export function average(a, b) { return (a + b) / 2; }\n',
                                         'verification_request': 'OFFLINE TEST ONLY: inspect Spark-proposed-math.js and unchanged fixture/test.mjs; report actual test result.'})
                else:
                    assert 'OFFLINE reviewer protocol fixture reports' in prompt
                    content = 'OFFLINE final fixture answer. The scripted protocol control reports three passing cases; no live agent judgment claimed.'
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'model': 'muse-spark-1.3',
                     'choices': [{'finish_reason': 'stop', 'message': {'content': content}}],
                     'usage': {'prompt_tokens': 10, 'completion_tokens': 20, 'total_tokens': 30}}).encode())
            def log_message(self, *args):
                pass
        model = ThreadingHTTPServer(('127.0.0.1', 0), FakeModel)
        thread = threading.Thread(target=model.serve_forever, daemon=True)
        thread.start()
        key = root / 'fixture-key'
        key.write_text('OFFLINE-NOT-REAL-KEY\n'); key.chmod(0o600)
        hub_port, api_port = free_port(), free_port()
        while hub_port == api_port:
            api_port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith(('HUB_', 'META_API_KEY'))}
        env.update(HUB_STATE_DIR=str(root / 'state'), HUB_FILM_DIR=str(film), HUB_PORT=str(hub_port),
                   HUB_API_PORT=str(api_port), HUB_FILM_URL='http://127.0.0.1:%d' % hub_port,
                   HUB_FILM_API='http://127.0.0.1:%d' % api_port, HUB_META_KEY_FILE=str(key),
                   HUB_META_CAMPAIGN_DIR=str(root / 'allowance'), HUB_DISPATCHER_MODEL='on',
                   HUB_META_TEST_ENDPOINT='http://127.0.0.1:%d/v1/chat/completions' % model.server_port,
                   HUB_META_ALLOW_LOOPBACK_TEST='1', HUB_FILM_TEST_MODE='1', HUB_DISPATCHER_POLL_MS='100')
        def run(script, *args, want=0):
            p = subprocess.run([sys.executable, str(HUB_DIR / 'scripts' / script), *args],
                               env=env, capture_output=True, text=True, timeout=65)
            assert p.returncode == want, (script, p.returncode, p.stderr)
            return p.stdout
        server = subprocess.Popen([shutil.which('node'), 'src/server.ts'], cwd=HUB_DIR,
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            base = env['HUB_FILM_URL']
            for _ in range(100):
                try:
                    with urllib.request.urlopen(base + '/hub/status', timeout=1) as r:
                        assert json.load(r)['transport']['wired']
                    break
                except (OSError, ValueError):
                    if server.poll() is not None:
                        raise AssertionError('Owned Hub exited before readiness')
                    time.sleep(0.05)
            else:
                raise AssertionError('Owned Hub did not become ready')
            run('demo-meta.py', 'prepare')
            assert len(hits) == 0
            before = subprocess.run([shutil.which('node'), 'test.mjs'], cwd=film / 'fixture', capture_output=True, text=True)
            assert before.returncode == 1 and '2 case(s) failed' in before.stderr
            print('PASS prepare uses normal enrollment, zero model HTTP; original frozen fixture fails 2/3')
            run('meta-api.py', 'init', '--name', 'OFFLINE-PHASE-PROTOCOL')
            owner = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            owner.open(urllib.request.Request(base + '/hub/login', data=b'{}', headers={'Content-Type': 'application/json'})).close()
            page = owner.open(base + '/hub/work?project=hub-demo').read().decode()
            fields = dict(re.findall(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"', page))
            assert {'operationId', 'expectedRevision', 'projectId'} <= fields.keys()
            fields.update(question='OFFLINE TEST OWNER REQUEST: repair average()', toId=json.loads((film / 'spark-connection.json').read_text())['identityId'])
            body = urllib.parse.urlencode(fields).encode()
            saved = owner.open(urllib.request.Request(base + '/hub/work/request', data=body,
                 headers={'Content-Type': 'application/x-www-form-urlencoded', 'Origin': base})).read().decode()
            state = json.loads((root / 'state/hub-demo.json').read_text())
            help_id = next(iter(state['state']['help']))
            for _ in range(100):
                if (root / 'allowance/call-01-dispatch.json').exists(): break
                time.sleep(0.05)
            assert len(hits) == 1
            print('PASS real workpage form saves request; actual dispatcher invokes bundled helper against loopback fixture')
            run('demo-meta.py', 'proposal', help_id)
            assert len(hits) == 2
            assert hashlib.sha256((film / 'fixture/math.js').read_bytes()).hexdigest() == json.loads((film / 'FIXTURE-FREEZE.json').read_text())['math.js']
            phase = json.loads((film / 'PHASE.json').read_text())
            hid = phase['verification_help']
            run('demo-meta.py', 'participant', 'inbox')
            run('demo-meta.py', 'participant', 'get-help', hid)
            run('demo-meta.py', 'participant', 'accept', hid)
            print('PASS proposal saves exact model fixture output and real addressed request; no automatic code application')
            # Explicitly scripted offline protocol control, never presented as Main's judgment.
            shutil.copyfile(film / 'Spark-proposed-math.js', film / 'fixture/math.js')
            after = subprocess.run([shutil.which('node'), 'test.mjs'], cwd=film / 'fixture', capture_output=True, text=True)
            assert after.returncode == 0 and after.stdout == 'all average() cases pass\n'
            answer = film / 'offline-review.txt'
            answer.write_text('OFFLINE reviewer protocol fixture reports actual node test.mjs exit0, all average() cases pass; no live Main participant claimed.')
            run('demo-meta.py', 'participant', 'answer', hid, '--file', str(answer))
            run('demo-meta.py', 'finish')
            final = json.loads((film / 'FINAL-READBACK.json').read_text())['help']
            assert final['state'] == 'answered' and final['answer'].startswith('OFFLINE final fixture answer')
            assert len(hits) == 3
            print('PASS final phase consumes actual HTTP reply and records exact final fixture answer; 3 local model-fixture requests total')
            run('demo-meta.py', 'proposal', help_id, want=1)
            run('demo-meta.py', 'finish', want=1)
            assert len(hits) == 3
            print('PASS duplicate phases refused, no fourth request; all evidence remains private')
            print('OFFLINE PHASE PROTOCOL PASS — 0 Meta requests, no live participant or model result claimed')
        finally:
            server.terminate()
            try:
                server.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill(); server.communicate()
            model.shutdown(); model.server_close(); thread.join()


if __name__ == '__main__':
    main()
