#!/usr/bin/env python3
"""Offline subprocess checks. All HTTP hits a local test fixture, never Meta."""
import concurrent.futures
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HELPER = Path(__file__).with_name('meta-api.py')
FIXTURE_KEY = 'offline-fixture-key-not-valid'


class MetaHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hub-meta-offline-')
        self.root = Path(self.temp.name)
        self.key = self.root / 'key.txt'
        self.key.write_text(FIXTURE_KEY + '\n')
        self.key.chmod(0o600)
        self.hits = []
        self.status = 200
        self.hold = None
        self.data = {'model': 'muse-spark-1.3', 'choices': [{'finish_reason': 'stop',
                     'message': {'content': 'Visible fixture answer', 'reasoning_content': 'HIDDEN-DO-NOT-EMIT'}}],
                     'usage': {'prompt_tokens': 10, 'completion_tokens': 20, 'total_tokens': 30}}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.hits.append({'path': self.path, 'body': body,
                                  'authorized': self.headers.get('Authorization') == 'Bearer ' + FIXTURE_KEY})
                if owner.hold:
                    owner.hold.wait(5)
                self.send_response(owner.status)
                if owner.status == 302:
                    self.send_header('Location', '/redirected')
                self.end_headers()
                raw = owner.data if isinstance(owner.data, bytes) else json.dumps(owner.data).encode()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Interrupted local-client control, not a provider result.
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('HUB_META_', 'META_API_KEY'))}
        self.env.update(HUB_META_KEY_FILE=str(self.key), HUB_META_CAMPAIGN_DIR=str(self.root / 'campaign'),
                        HUB_META_TEST_ENDPOINT='http://127.0.0.1:%d/v1/chat/completions' % self.server.server_port,
                        HUB_META_ALLOW_LOOPBACK_TEST='1')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_helper(self, *args, expected=0):
        p = subprocess.run([sys.executable, str(HELPER), *args], env=self.env,
                           text=True, capture_output=True, timeout=10)
        self.assertEqual(p.returncode, expected, (p.stdout, p.stderr))
        self.assertNotIn(FIXTURE_KEY, p.stdout + p.stderr)
        self.assertNotIn('HIDDEN-DO-NOT-EMIT', p.stdout + p.stderr)
        return p

    def init(self, calls=3):
        self.run_helper('init', '--name', 'OFFLINE_TEST_ONLY', '--max-calls', str(calls))

    def chat(self, role='worker', expected=0, model='muse-spark-1.3'):
        return self.run_helper('chat', '--model', model, '--role', role,
                               '--prompt', 'Offline fixture only', expected=expected)

    def budget(self):
        return json.loads((self.root / 'campaign/budget.json').read_text())

    def test_doctor_is_offline_and_no_campaign_write(self):
        result = json.loads(self.run_helper('doctor').stdout)
        self.assertEqual(result['authentication'], 'NOT_CONTACTED')
        self.assertEqual(self.hits, [])
        self.assertFalse((self.root / 'campaign').exists())

    def test_missing_key_fails_without_request(self):
        del self.env['HUB_META_KEY_FILE']
        self.run_helper('doctor', expected=1)
        self.assertEqual(self.hits, [])

    def test_key_file_mode_is_not_silently_changed(self):
        self.key.chmod(0o644)
        self.run_helper('doctor', expected=1)
        self.assertEqual(self.key.stat().st_mode & 0o777, 0o644)

    def test_symlink_key_is_refused(self):
        link = self.root / 'link'
        link.symlink_to(self.key)
        self.env['HUB_META_KEY_FILE'] = str(link)
        self.run_helper('doctor', expected=1)

    def test_ambiguous_auth_is_refused(self):
        self.env['META_API_KEY'] = FIXTURE_KEY
        self.run_helper('doctor', expected=1)

    def test_environment_auth_is_supported(self):
        del self.env['HUB_META_KEY_FILE']
        self.env['META_API_KEY'] = FIXTURE_KEY
        self.init()
        self.chat()
        self.assertTrue(self.hits[0]['authorized'])

    def test_init_no_http_and_no_reset(self):
        self.init()
        original = (self.root / 'campaign/budget.json').read_bytes()
        self.run_helper('init', '--name', 'RESET_ATTEMPT', expected=1)
        self.assertEqual(original, (self.root / 'campaign/budget.json').read_bytes())
        self.assertEqual(self.hits, [])

    def test_chat_requires_explicit_budget(self):
        self.chat(expected=1)
        self.assertEqual(self.hits, [])

    def test_visible_response_usage_and_private_receipt(self):
        self.init()
        result = json.loads(self.chat().stdout)
        self.assertEqual(result['usage']['total_tokens'], 30)
        receipt = self.root / 'campaign/call-01-worker.json'
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        doc = json.loads(receipt.read_text())
        self.assertTrue(doc['loopback_test'])
        self.assertEqual(doc['retries'], 0)
        self.assertEqual(doc['resolved_model'], 'muse-spark-1.3')
        self.assertEqual(self.hits[0]['body']['max_tokens'], 4000)

    def test_one_dispatch_then_two_workers_and_total_cap(self):
        self.init()
        self.chat('dispatch')
        self.chat('dispatch', expected=1)
        self.chat()
        self.chat()
        self.chat(expected=1)
        self.assertEqual(len(self.hits), 3)
        self.assertEqual(len(self.budget()['reservations']), 3)

    def test_parallel_workers_cannot_overspend(self):
        self.init(2)
        def call(_):
            return subprocess.run([sys.executable, str(HELPER), 'chat', '--model', 'muse-spark-1.3',
                   '--role', 'worker', '--prompt', 'OFFLINE'], env=self.env, capture_output=True, timeout=10).returncode
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            codes = list(pool.map(call, range(5)))
        self.assertEqual(codes.count(0), 2)
        self.assertEqual(codes.count(1), 3)
        self.assertEqual(len(self.hits), 2)
        self.assertEqual(len(self.budget()['reservations']), 2)

    def test_http_error_kept_no_retry_no_error_body_leak(self):
        self.init()
        self.status, self.data = 401, (FIXTURE_KEY + ' provider error body').encode()
        self.chat(expected=1)
        self.assertEqual(len(self.hits), 1)
        self.assertEqual(len(self.budget()['reservations']), 1)
        self.assertEqual(json.loads((self.root / 'campaign/call-01-worker.json').read_text())['error'], 'HTTP_401')

    def test_interruption_does_not_recover_spent_request(self):
        self.init(1)
        self.hold = threading.Event()
        child = subprocess.Popen([sys.executable, str(HELPER), 'chat', '--model', 'muse-spark-1.3',
                '--role', 'worker', '--prompt', 'OFFLINE INTERRUPTION'], env=self.env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            end = time.monotonic() + 3
            while not self.hits and time.monotonic() < end:
                time.sleep(0.01)
            self.assertEqual(len(self.hits), 1)
            child.terminate()
            child.communicate(timeout=3)
            self.assertEqual(self.budget()['reservations'][0]['state'], 'reserved_before_HTTP_outcome_unknown')
            self.chat(expected=1)
            self.assertEqual(len(self.hits), 1)
            self.assertFalse((self.root / 'campaign/call-01-worker.json').exists())
        finally:
            self.hold.set()
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_redirect_never_follows(self):
        self.init()
        self.status = 302
        self.chat(expected=1)
        self.assertEqual(len(self.hits), 1)

    def test_resolved_identity_must_be_present_and_exact(self):
        self.init()
        self.data['model'] = 'different-model'
        self.chat(expected=1)
        del self.data['model']
        self.chat(expected=1)
        self.assertEqual(len(self.hits), 2)

    def test_empty_visible_completion_is_failure_not_success(self):
        self.init()
        self.data['choices'][0]['message']['content'] = None
        self.chat(expected=1)

    def test_invalid_json_and_oversize_response_keep_reservations(self):
        self.init()
        self.data = b'not json'
        self.chat(expected=1)
        self.data = b'x' * (2 * 1024 * 1024 + 1)
        self.chat(expected=1)
        self.assertEqual(len(self.budget()['reservations']), 2)

    def test_bad_model_tokens_and_prompt_never_send(self):
        self.init()
        self.chat(model='other-model', expected=1)
        self.run_helper('chat', '--model', 'muse-spark-1.3', '--max-tokens', '4001', '--prompt', 'x', expected=1)
        self.run_helper('chat', '--model', 'muse-spark-1.3', '--prompt', 'x' * 32001, expected=1)
        self.assertEqual(self.hits, [])
        self.assertEqual(self.budget()['reservations'], [])

    def test_external_test_endpoint_is_refused(self):
        self.env['HUB_META_TEST_ENDPOINT'] = 'https://example.invalid/v1/chat/completions'
        self.run_helper('doctor', expected=1)
        self.assertEqual(self.hits, [])

    def test_visible_key_echo_redacted_no_raw_response_saved(self):
        self.init()
        self.data['choices'][0]['message']['content'] = 'Echo ' + FIXTURE_KEY
        self.chat()
        for path in (self.root / 'campaign').iterdir():
            if path.is_file():
                self.assertNotIn(FIXTURE_KEY, path.read_text())


if __name__ == '__main__':
    unittest.main(verbosity=2)
