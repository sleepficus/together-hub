// Offline navigation/DOM regression. Executes the shipped page script and
// serializes its real HTML GET form against changing in-memory responses.
// No HTTP listener, browser service, model request, or installed-state access.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const source = process.env.WORKPAGE_REFRESH_SOURCE_ROOT
  ? resolve(process.env.WORKPAGE_REFRESH_SOURCE_ROOT, 'hub/src/workpage.ts')
  : new URL('../src/workpage.ts', import.meta.url).pathname;
const { renderWorkPage } = await import(pathToFileURL(source).href);
const state: any = {
  project: { id: 'refresh-project', goal: 'OFFLINE refresh fixture' },
  identities: { 'hub-owner': { id: 'hub-owner', displayName: 'Offline owner', creationSource: 'owner' },
                reader: { id: 'reader', displayName: 'Offline participant', status: 'active' } },
  sessions: {}, members: { reader: { identityId: 'reader' } },
  credentials: { reader: { identityId: 'reader', status: 'active', projectIds: ['refresh-project'], scopes: ['help:write'] } },
  help: { chosen: { id: 'chosen', createdAt: '2026-10-29T00:00:00Z', state: 'offered', question: 'Existing request', actorId: 'hub-owner' } },
  messages: {},
};
const storage = new Map<string, string>();
const requests: Request[] = [];
let html = '', currentURL = 'http://offline.test/hub/work?project=refresh-project&help=chosen#request';
let form: any, refresh: any;
const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2].replaceAll('&amp;', '&')]));
function node(extra: any = {}) {
  const listeners: Record<string, (() => void)[]> = {};
  return { ...extra, addEventListener(name: string, fn: () => void) { (listeners[name] ??= []).push(fn); },
           fire(name: string) { for (const fn of listeners[name] ?? []) fn(); } };
}
function getPage(url = currentURL) {
  currentURL = url;
  const request = new Request(currentURL, { method: 'GET' });
  requests.push(request);
  const selected = new URL(currentURL).searchParams.get('help') || 'chosen';
  const savedOperation = new URL(currentURL).searchParams.get('savedOperation') || undefined;
  html = renderWorkPage(state, { selected, saved: !!savedOperation, savedOperation,
    draft: { projectId: 'refresh-project', question: '', toId: '',
              operationId: 'fresh-get-' + requests.length, expectedRevision: '1' } });
  const tag = html.match(/<form\b[^>]*id="work-form"[^>]*>/)![0];
  const start = html.indexOf(tag), end = html.indexOf('</form>', start);
  const body = html.slice(start, end);
  const fields = Object.fromEntries([...body.matchAll(/<input\b[^>]*>/g)].map(m => {
    const a = attrs(m[0]); return [a.name, { value: a.value || '' }];
  }));
  fields.question = { value: '' };
  fields.toId = { value: '', options: [{ value: '' }, { value: 'reader' }] } as any;
  const a = attrs(tag);
  form = node({ elements: fields, dataset: { retry: a['data-retry'], saved: a['data-saved'], savedOperation: a['data-saved-operation'] },
                querySelector: () => ({ disabled: false, textContent: 'Share request' }) });
  const refreshMatch = html.match(/<form\b[^>]*id="work-refresh-form"[^>]*>([\s\S]*?)<\/form>/);
  refresh = refreshMatch ? node({ attributes: attrs(refreshMatch[0].split('>')[0] + '>'),
               fields: [...refreshMatch[1].matchAll(/<input\b[^>]*>/g)].map(m => attrs(m[0])) }) : null;
  const context = {
    document: { getElementById: (id: string) => id === 'work-form' ? form : id === 'work-refresh-form' ? refresh : null },
    sessionStorage: { getItem: (k: string) => storage.get(k) ?? null,
                     setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  vm.runInNewContext(script, context);
}
function clickRefresh() {
  if (refresh) {
    refresh.fire('submit'); // Executes the production draft-save listener.
    const target = new URL(refresh.attributes.action, currentURL);
    const params = new URLSearchParams();
    for (const field of refresh.fields) params.append(field.name, field.value || '');
    target.search = params.toString();
    // Main's installed Chrome control: an identical path/query plus fragment
    // can remain same-document even for a submitted GET form. Do not assume GET
    // alone proves a request; a refreshed page must change the request URL.
    assert.equal((refresh.attributes.method || 'get').toLowerCase(), 'get');
    const old = new URL(currentURL);
    if (target.pathname + target.search === old.pathname + old.search && target.hash) currentURL = target.href;
    else getPage(target.href);
  } else {
    // The pre-repair anchor: identical pathname/query only updates the fragment.
    const link = html.match(/<a\b[^>]*class="refresh"[^>]*>/)![0];
    const target = new URL(attrs(link).href, currentURL), old = new URL(currentURL);
    if (target.pathname + target.search !== old.pathname + old.search) getPage(target.href);
    else currentURL = target.href;
  }
}
getPage();
const draft = { question: 'Unsent draft: keep my exact words.', toId: 'reader', operationId: form.elements.operationId.value, expectedRevision: '1' };
for (const [key, value] of Object.entries(draft)) form.elements[key].value = value;
// Do not fire input: Refresh must explicitly save even a last-moment edit.
state.help.chosen.answer = 'NEW REPLY ONE'; state.help.chosen.state = 'answered';
clickRefresh();
assert.equal(requests.length, 2, 'Refresh must request a fresh document when already on the selected URL');
assert(html.includes('NEW REPLY ONE'), 'first refresh must show the changed backend answer');
console.log('PASS same-URL Refresh performs a GET and shows a newly arrived answer');
state.help.chosen.answer = 'NEW REPLY TWO';
clickRefresh();
assert.equal(requests.length, 3, 'second same-URL refresh must request again');
assert(html.includes('NEW REPLY TWO'));
console.log('PASS repeated Refresh fetches the next fresh response');
const refreshOne = new URL(requests[1].url), refreshTwo = new URL(requests[2].url);
assert(refreshOne.searchParams.get('_refresh'), 'first refreshed document needs a fresh query value');
assert.notEqual(refreshOne.searchParams.get('_refresh'), refreshTwo.searchParams.get('_refresh'), 'each rendered Refresh must target a different query');
console.log('PASS successive renderings have distinct request URLs, not same-document fragment navigation');
for (const [key, value] of Object.entries(draft)) assert.equal(form.elements[key].value, value, key + ' must survive GET refresh');
console.log('PASS unsent text, recipient, operation ID and revision survive repeated refresh');
assert.equal(new URL(currentURL).searchParams.get('project'), 'refresh-project');
assert.equal(new URL(currentURL).searchParams.get('help'), 'chosen');
assert(requests.every(request => request.method === 'GET'));
assert.equal(Object.keys(state.help).length, 1);
console.log('PASS project/selected request preserved; no POST or duplicate create');
// A selection reached without an explicit help query must also stay selected.
getPage('http://offline.test/hub/work?project=refresh-project');
clickRefresh();
assert.equal(new URL(currentURL).searchParams.get('help'), 'chosen');
console.log('PASS implicit selected request becomes explicit on refresh');
getPage('http://offline.test/hub/work?project=refresh-project&help=chosen&saved=1&savedOperation=older-submitted-op#request');
form.elements.question.value = 'New unsent words after a prior successful save';
const pendingOperation = form.elements.operationId.value;
clickRefresh();
assert.equal(form.elements.question.value, 'New unsent words after a prior successful save');
assert.equal(form.elements.operationId.value, pendingOperation);
assert.equal(Object.keys(state.help).length, 1);
assert(requests.every(request => request.method === 'GET'));
console.log('PASS stale success URL does not clear a newer draft or resubmit the old request');
console.log('7/7 offline refresh navigation checks PASS; no listener or model call');
