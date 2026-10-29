#!/usr/bin/env python3
"""Bundled, bounded Meta text-completion helper. No retries or native agent tools.

Python 3 standard library only. Configuration and budgets are local/private;
doctor never contacts a provider. See META-SETUP.md before enabling dispatch.
"""
import argparse
import datetime
import fcntl
import json
import os
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MODEL = 'muse-spark-1.3'
MAX_RESPONSE = 2 * 1024 * 1024


class SetupError(Exception):
    pass


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def key():
    """Never put a key, its file contents, or provider error bodies in errors."""
    filename = os.environ.get('HUB_META_KEY_FILE')
    env = os.environ.get('META_API_KEY')
    if filename and env:
        raise SetupError('AMBIGUOUS_KEY_CONFIG: choose key file OR environment key')
    if filename:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600:
                raise SetupError('KEY_FILE_NOT_PRIVATE: regular owned file mode 0600 required')
            raw = f.read(4097)
        if len(raw) > 4096:
            raise SetupError('KEY_FORMAT_INVALID')
        value = raw.decode('utf-8').strip()
    elif env:
        value = env.strip()
    else:
        raise SetupError('KEY_NOT_CONFIGURED: set HUB_META_KEY_FILE or META_API_KEY privately')
    if not value or len(value) > 4096 or any(c.isspace() for c in value):
        raise SetupError('KEY_FORMAT_INVALID')
    return value


def endpoint():
    value = os.environ.get('HUB_META_TEST_ENDPOINT')
    if value:
        parsed = urllib.parse.urlparse(value)
        if (os.environ.get('HUB_META_ALLOW_LOOPBACK_TEST') != '1' or
                parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or
                parsed.username or parsed.password or parsed.query or parsed.fragment or
                parsed.path != '/v1/chat/completions'):
            raise SetupError('TEST_ENDPOINT_REFUSED: explicit loopback fixture only')
        return value
    return 'https://api.meta.ai/v1/chat/completions'


def campaign_dir():
    explicit = os.environ.get('HUB_META_CAMPAIGN_DIR')
    state = os.environ.get('HUB_STATE_DIR')
    default_state = Path(__file__).resolve().parent.parent / '.state'
    return Path(explicit) if explicit else Path(state or default_state) / 'meta-campaign'


def private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise SetupError('CAMPAIGN_DIR_NOT_PRIVATE: owned directory mode 0700 required')


def private_open(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW, 0o600)
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600:
        os.close(fd)
        raise SetupError('CAMPAIGN_FILE_NOT_PRIVATE')
    return fd


def atomic_json(path, doc):
    temp = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    fd = private_open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(doc, f, indent=2)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temp.exists():
            temp.unlink()


def locked_budget(root):
    private_dir(root)
    return os.fdopen(private_open(root / 'budget.lock', os.O_RDWR | os.O_CREAT), 'a+')


def read_budget(root):
    with os.fdopen(private_open(root / 'budget.json', os.O_RDONLY)) as f:
        doc = json.load(f)
    if (doc.get('model') != MODEL or type(doc.get('max_calls')) is not int or
            not 1 <= doc['max_calls'] <= 3 or doc.get('dispatch_calls') != 1 or
            not isinstance(doc.get('reservations'), list)):
        raise SetupError('CAMPAIGN_BUDGET_INVALID')
    return doc


def initialize(args):
    key()
    endpoint()
    root = campaign_dir()
    with locked_budget(root) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if os.path.lexists(root / 'budget.json'):
            raise SetupError('CAMPAIGN_ALREADY_EXISTS: never reset a spent or interrupted allowance')
        atomic_json(root / 'budget.json', {'campaign': args.name, 'created_at': utc(),
                    'model': MODEL, 'max_calls': args.max_calls, 'dispatch_calls': 1,
                    'max_tokens_per_call': 4000, 'reservations': []})
    print(json.dumps({'initialized': True, 'provider_requests': 0, 'max_calls': args.max_calls}))


def reserve(root, role, max_tokens):
    with locked_budget(root) as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = read_budget(root)
        if len(doc['reservations']) >= doc['max_calls']:
            raise SetupError('CAMPAIGN_CALL_CAP_REACHED: no request sent')
        if role == 'dispatch' and any(r['role'] == role for r in doc['reservations']):
            raise SetupError('DISPATCH_CAP_REACHED: no request sent; Hub uses rules fallback')
        call = len(doc['reservations']) + 1
        doc['reservations'].append({'call': call, 'role': role, 'at': utc(),
                                    'max_tokens': max_tokens, 'state': 'reserved_before_HTTP_outcome_unknown'})
        atomic_json(root / 'budget.json', doc)
        return call


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def chat(args):
    if args.model != MODEL or not 1 <= args.max_tokens <= 4000:
        raise SetupError('MODEL_OR_TOKEN_SETTING_REFUSED')
    secret = key()
    url = endpoint()
    prompt = Path(args.prompt_file).read_text() if args.prompt_file else args.prompt
    if not prompt or len(prompt.encode('utf-8')) > 32000:
        raise SetupError('BOUNDED_PROMPT_REQUIRED: maximum 32000 bytes')
    root = campaign_dir()
    call = reserve(root, args.role, args.max_tokens)
    body = {'model': args.model, 'max_tokens': args.max_tokens,
            'messages': [{'role': 'user', 'content': prompt}]}
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
              headers={'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
    started = time.monotonic()
    status, result, error, reported_model = None, None, None, None
    try:
        # Never leak a credential via a redirect or an ambient proxy.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
        with opener.open(request, timeout=55) as response:
            status = response.status
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise SetupError('RESPONSE_TOO_LARGE')
        data = json.loads(raw)
        if isinstance(data.get('model'), str):
            reported_model = data['model'].replace(secret, '[REDACTED]')[:256]
        if data.get('model') != args.model:
            raise SetupError('RESOLVED_MODEL_MISMATCH_OR_MISSING')
        choice = data.get('choices', [{}])[0]
        content = choice.get('message', {}).get('content')
        if not isinstance(content, str) or not content.strip():
            raise SetupError('VISIBLE_COMPLETION_MISSING')
        # Allowlist visible answer and usage only; never forward hidden reasoning.
        usage = {k: v for k, v in data.get('usage', {}).items()
                 if k in ('prompt_tokens', 'completion_tokens', 'total_tokens') and type(v) is int and v >= 0}
        result = {'model': data['model'], 'choices': [{'finish_reason': choice.get('finish_reason'),
                  'message': {'role': 'assistant', 'content': content}}], 'usage': usage}
    except urllib.error.HTTPError as exc:
        status, error = exc.code, 'HTTP_' + str(exc.code)
    except SetupError as exc:
        error = str(exc)
    except Exception as exc:
        error = type(exc).__name__  # No exception strings or provider bodies.
    receipt = {'call': call, 'role': args.role, 'requested_model': args.model,
               'resolved_model': reported_model,
               'provider': 'Meta Model API', 'harness': 'bundled text completion; host-mediated actions',
               'http_status': status, 'elapsed_seconds': round(time.monotonic() - started, 3),
               'usage': result['usage'] if result else None, 'error': error, 'retries': 0,
               'billing': 'UNKNOWN; no current price or native-tool claim',
               'loopback_test': url.startswith('http://127.0.0.1:')}
    atomic_json(root / ('call-%02d-%s.json' % (call, args.role)), receipt)
    if error:
        raise SetupError('REQUEST_FAILED: ' + error + '; reservation retained; no retry')
    sys.stdout.write(json.dumps(result).replace(secret, '[REDACTED]') + '\n')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('doctor', help='offline key/config check; no request or budget write')
    init = sub.add_parser('init', help='create a NEW bounded campaign; never overwrite')
    init.add_argument('--name', required=True)
    init.add_argument('--max-calls', type=int, choices=(1, 2, 3), default=3)
    c = sub.add_parser('chat')
    c.add_argument('--model', required=True)
    c.add_argument('--max-tokens', type=int, default=4000)
    prompt = c.add_mutually_exclusive_group(required=True)
    prompt.add_argument('--prompt')
    prompt.add_argument('--prompt-file')
    c.add_argument('--role', choices=('dispatch', 'worker'), default='dispatch')
    args = p.parse_args()
    if args.command == 'doctor':
        key()
        url = endpoint()
        print(json.dumps({'configuration': 'READY_OFFLINE', 'model': MODEL,
                          'provider_requests': 0, 'authentication': 'NOT_CONTACTED',
                          'endpoint': 'LOOPBACK_TEST' if url.startswith('http:') else 'Meta Model API',
                          'campaign_initialized': (campaign_dir() / 'budget.json').is_file()}))
    elif args.command == 'init':
        initialize(args)
    else:
        chat(args)


if __name__ == '__main__':
    try:
        main()
    except SetupError as exc:
        sys.stderr.write(str(exc) + '\n')
        sys.exit(1)
    except Exception as exc:
        sys.stderr.write('LOCAL_SETUP_FAILED: ' + type(exc).__name__ + '\n')
        sys.exit(1)
