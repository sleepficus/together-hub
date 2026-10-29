#!/usr/bin/env python3
"""Explicit demo phases, not an autonomous worker. See META-DEMO.md.

prepare: enroll private scoped identities and freeze a failing toy fixture.
proposal: consume the owner's UI-created task, ask Spark once, save proposal,
          and deliver Spark's exact verification request to the real reviewer.
participant: actual reviewer chooses each inbox/read/accept/answer action.
finish: consume the reviewer's real delivered answer, ask Spark once, and post
        its exact final answer. Never applies code or runs a model's proposal.
"""
import argparse
import hashlib
import http.cookiejar
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(os.environ.get('HUB_FILM_DIR', str(Path(os.environ.get('HUB_STATE_DIR', '.state')) / 'film-campaign'))).resolve()
HUB = os.environ.get('HUB_FILM_URL', 'http://127.0.0.1:19550')
API = os.environ.get('HUB_FILM_API', 'http://127.0.0.1:19547')
PROJECT = 'hub-demo'
HELPER = Path(__file__).with_name('meta-api.py')


class LocalRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlparse(req.full_url), urllib.parse.urlparse(newurl)
        if new.scheme != 'http' or new.netloc != old.netloc:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def save(name, value):
    path = ROOT / name
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    data = value if isinstance(value, str) else json.dumps(value, indent=2) + '\n'
    with path.open('x') as f:
        os.chmod(path, 0o600)
        f.write(data)


def load(name):
    return json.loads((ROOT / name).read_text())


def request(base, path, body=None, token=None, client=None):
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.username or parsed.password:
        raise ValueError('Demo HTTP restricted to explicit loopback host')
    headers = {'Accept': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        headers['Content-Type'] = 'application/json'
        # Save operation id BEFORE request; never automatically retry unknown writes.
        save('operations/' + body['operationId'] + '.json', {'path': path, 'body': body})
    request = urllib.request.Request(base + path, headers=headers,
              data=json.dumps(body).encode() if body is not None else None)
    opener = client or urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalRedirect)
    with opener.open(request, timeout=15) as response:
        raw = response.read(1024 * 1024)
        return json.loads(raw) if 'json' in response.headers.get('Content-Type', '') else None


def op(**values):
    return dict(operationId=str(uuid.uuid4()), **values)


def agent(role, path, body=None):
    config = load(role + '-connection.json')
    token = (ROOT / config['credentialFile']).read_text().strip()
    return request(config['baseUrl'], '/api/v1/projects/' + PROJECT + path, body, token)


def phase_once(name):
    # An interrupted phase is kept as a pending attempt, never silently re-executed.
    save(name + '.attempt.json', {'phase': name, 'status': 'started; reconcile before any repeat'})


def prepare():
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    if ROOT.stat().st_mode & 0o777 != 0o700:
        raise ValueError('Private film directory must have mode 0700')
    phase_once('prepare')
    jar = http.cookiejar.CookieJar()
    owner = urllib.request.build_opener(urllib.request.ProxyHandler({}), LocalRedirect,
                                        urllib.request.HTTPCookieProcessor(jar))
    request(HUB, '/hub/login', op(), client=owner)
    for role, label in [('spark', 'API Spark — Meta coding worker'), ('main', 'Main Chad — actual Codex reviewer')]:
        if os.environ.get('HUB_FILM_TEST_MODE') == '1':
            label = 'OFFLINE TEST — ' + role + ' protocol fixture'
        invite = request(HUB, '/hub/keydesk/invite', op(projectId=PROJECT, displayName=label,
                      scopes=['read', 'help:write'], credentialTtlDays='30'), client=owner)
        metadata = ({'adapter': 'Meta API bridge (host-mediated)', 'provider': 'Meta Model API',
                     'model': 'requested muse-spark-1.3; verify actual call receipt',
                     'harness': 'bundled Python text-completion helper'} if role == 'spark' else
                    {'adapter': 'Codex actual Main participant', 'harness': 'Codex'})
        if os.environ.get('HUB_FILM_TEST_MODE') == '1':
            metadata = {'adapter': 'offline protocol control', 'provider': 'LOOPBACK TEST',
                        'model': 'OFFLINE fixture; no real model', 'harness': 'scripted test'}
        credential = request(API, '/api/v1/projects/' + PROJECT + '/enrollment/exchange',
                             op(**metadata), invite['token'])
        save(role + '.token', credential['token'] + '\n')
        save(role + '-connection.json', {'baseUrl': API, 'projectId': PROJECT,
             'identityId': invite['identityId'], 'credentialFile': role + '.token',
             'role': label, 'permissions': credential['scopes'],
             'credentialId': credential['credentialId'], 'sessionId': credential['sessionId'],
             'expiresAt': credential.get('expiresAt'), 'credentialDays': 30})
    original = '// Fixture under repair: average() must return the mean of two numbers.\nexport function average(a, b) {\n  return a + b; // BUG: sums instead of averaging\n}\n'
    test = """import { average } from './math.js';

let failed = 0;
const cases = [[4, 6, 5], [10, 0, 5], [-2, 2, 0]];
for (const [a, b, want] of cases) {
  const got = average(a, b);
  if (got !== want) { console.error(`average(${a}, ${b}) = ${got}, want ${want}`); failed++; }
}
if (failed > 0) { console.error(`${failed} case(s) failed`); process.exit(1); }
console.log('all average() cases pass');
"""
    save('fixture/math.js', original)
    save('fixture/test.mjs', test)
    save('fixture/package.json', '{"type":"module"}\n')
    save('FIXTURE-FREEZE.json', {name: hashlib.sha256((ROOT / 'fixture' / name).read_bytes()).hexdigest()
                               for name in ['math.js', 'test.mjs', 'package.json']})
    save('PREPARED.json', {'provider_requests_by_prepare': 0, 'project': PROJECT,
                         'main': load('main-connection.json')['identityId'],
                         'spark': load('spark-connection.json')['identityId'],
                         'task': 'Fix average() to return the mean of two numbers. Ask Main Chad to review your exact proposal and run the unchanged three-case test. Return the actual result; do not claim execution you did not perform.'})
    print('Prepared private identities and original fixture. No provider calls. Run node fixture/test.mjs and preserve the failing receipt; Main creates the request in /hub/work only when filming starts.')


def help_get(role, help_id):
    return agent(role, '/help/' + help_id)['help']


def accept(role, help_id):
    current = help_get(role, help_id)
    return agent(role, '/help/' + help_id + '/accept', op(expectedRevision=current['revision']))


def answer(role, help_id, text):
    current = help_get(role, help_id)
    return agent(role, '/help/' + help_id + '/answer', op(expectedRevision=current['revision'], answer=text))


def worker(name, prompt):
    save(name + '-prompt.txt', prompt)
    try:
        run = subprocess.run([sys.executable, str(HELPER), 'chat', '--model', 'muse-spark-1.3',
                              '--role', 'worker', '--max-tokens', '4000', '--prompt-file', str(ROOT / (name + '-prompt.txt'))],
                             capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired as exc:
        def text(value):
            return value.decode('utf-8', errors='replace') if isinstance(value, bytes) else value or ''
        save(name + '-stdout.json', text(exc.stdout))
        save(name + '-stderr.txt', text(exc.stderr))
        raise ValueError('Worker interrupted; allowance unknown, partial outputs retained; no retry')
    save(name + '-stdout.json', run.stdout)
    save(name + '-stderr.txt', run.stderr)
    if run.returncode:
        raise ValueError('Worker failed; original stdout/stderr and reserved allowance retained; no retry')
    data = json.loads(run.stdout)
    if data['model'] != 'muse-spark-1.3':
        raise ValueError('Model mapping unverified')
    text = data['choices'][0]['message']['content']
    save(name + '-visible.txt', text)
    return text


def proposal(help_id):
    allowance = Path(os.environ.get('HUB_META_CAMPAIGN_DIR',
                     str(Path(os.environ.get('HUB_STATE_DIR', '.state')) / 'meta-campaign')))
    dispatch = json.loads((allowance / 'call-01-dispatch.json').read_text())
    if dispatch.get('http_status') != 200 or dispatch.get('error') or dispatch.get('resolved_model') != 'muse-spark-1.3':
        raise ValueError('First routing request did not succeed; inspect allowance, no worker call')
    phase_once('proposal')
    frozen = load('FIXTURE-FREEZE.json')
    for name, digest in frozen.items():
        if hashlib.sha256((ROOT / 'fixture' / name).read_bytes()).hexdigest() != digest:
            raise ValueError('Original fixture changed before production')
    inbox = agent('spark', '/inbox?limit=50')
    save('spark-inbox.json', inbox)
    record = help_get('spark', help_id)
    spark_id = load('spark-connection.json')['identityId']
    if not any(m.get('helpId') == help_id and m.get('recipientId') == spark_id
               and m.get('delivery') == 'delivered' for m in inbox['messages']):
        raise ValueError('Original UI request is not addressed to API Spark')
    if record['offeredById'] != 'hub-owner':
        raise ValueError('Original task must come from the actual owner workpage')
    save('original-help.json', record)
    save('spark-accepted.json', accept('spark', help_id))
    prompt = ('You are API Spark, the Meta coding worker. This is a real delivered Hub task. '
              'You cannot execute tools in this API call; the host will save your exact proposed file, '
              'and the real Main Chad participant will decide whether to apply and test it. '
              'Return ONLY JSON with code (complete replacement math.js) and verification_request '
              '(your exact request to Main, mentioning fixture/math.js, Spark-proposed-math.js and '
              'unchanged fixture/test.mjs; ask for actual command, exit, stdout/stderr and scope). '
              'Do not claim tests passed.\nTASK:\n' + record['question'] + '\nFILES:\n' +
              '\n'.join(name + '\n' + (ROOT / 'fixture' / name).read_text() for name in ['math.js', 'test.mjs', 'package.json']))
    visible = worker('spark-proposal', prompt)
    parsed = json.loads(visible)
    code, question = parsed['code'], parsed['verification_request']
    if not isinstance(code, str) or not code.strip() or not isinstance(question, str) or not question.strip():
        raise ValueError('Incomplete proposal; retain raw output, no repair or retry')
    save('Spark-proposed-math.js', code)
    save('spark-verification-request.txt', question)
    sent = agent('spark', '/help', op(question=question, toId=load('main-connection.json')['identityId']))
    save('spark-to-main.json', sent)
    save('PHASE.json', {'original_help': help_id, 'verification_help': sent['help']['id'],
                       'status': 'waiting for actual Main participant; no code applied by runner'})
    print(json.dumps(load('PHASE.json'), indent=2))


def participant(args):
    if args.action == 'inbox':
        value = agent('main', '/inbox?limit=50')
    elif args.action == 'get-help':
        value = agent('main', '/help/' + args.help_id)
    elif args.action == 'accept':
        value = accept('main', args.help_id)
    else:
        if not args.file:
            raise ValueError('Exact actual reviewer answer file required')
        value = answer('main', args.help_id, Path(args.file).read_text())
    # No token-bearing endpoint exists in this participant command.
    print(json.dumps(value, indent=2))


def finish():
    phase_once('finish')
    phase = load('PHASE.json')
    save('spark-inbox-after-main.json', agent('spark', '/inbox?limit=50'))
    review = help_get('spark', phase['verification_help'])
    if review['state'] != 'answered' or not review.get('answer'):
        raise ValueError('Actual Main answer is not recorded yet')
    if review.get('acceptedById') != load('main-connection.json')['identityId']:
        raise ValueError('Actual Main identity did not accept the verification request')
    frozen = load('FIXTURE-FREEZE.json')
    for name in ['test.mjs', 'package.json']:
        if hashlib.sha256((ROOT / 'fixture' / name).read_bytes()).hexdigest() != frozen[name]:
            raise ValueError('Frozen tests or package changed during review')
    save('actual-main-help-reply.json', review)
    text = worker('spark-final', 'You are API Spark. Read the ACTUAL delivered reviewer answer below and return a concise final answer to your original request. '
                  'Attribute code application and execution to Main Chad, not to you. State failures/unknowns exactly and restrict conclusions to the three frozen cases. '
                  'No claim of general correctness or native tool execution.\nOriginal task:\n' + load('original-help.json')['question'] +
                  '\nActual reviewer reply:\n' + review['answer'])
    save('spark-original-answer-posted.json', answer('spark', phase['original_help'], text))
    save('FINAL-READBACK.json', agent('spark', '/help/' + phase['original_help']))
    print('Exact Spark final answer posted to original help; provider receipts are in the separate campaign directory. No further calls.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    sub.add_parser('prepare')
    prop = sub.add_parser('proposal'); prop.add_argument('help_id')
    sub.add_parser('finish')
    a = sub.add_parser('participant')
    a.add_argument('action', choices=['inbox', 'get-help', 'accept', 'answer'])
    a.add_argument('help_id', nargs='?'); a.add_argument('--file')
    args = p.parse_args()
    if args.command == 'prepare': prepare()
    elif args.command == 'proposal': proposal(args.help_id)
    elif args.command == 'finish': finish()
    else: participant(args)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Never stringify HTTP error bodies, request headers or credential-bearing responses.
        sys.stderr.write('DEMO_STOPPED: ' + type(exc).__name__ + '; inspect private attempts/receipts, do not automatically repeat\n')
        sys.exit(1)
