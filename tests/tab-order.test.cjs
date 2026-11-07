const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function harness(initial) {
  let tabs = initial.map(tab => ({ windowId: 1, groupId: -1, pinned: false, ...tab }));
  const calls = { created: [], removed: [] };
  let nextId = Math.max(0, ...tabs.map(tab => tab.id)) + 1;
  const reindex = () => tabs.forEach((tab, index) => { tab.index = index; });
  reindex();
  const event = { addListener() {} };
  const listeners = {};
  const capture = name => ({ addListener(listener) { listeners[name] = listener; } });
  const context = vm.createContext({
    console, clearTimeout,
    setTimeout(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      if (milliseconds >= 30000) timer.unref();
      return timer;
    },
    chrome: {
      runtime: { onStartup: event, onInstalled: event, onMessage: event },
      contextMenus: { onClicked: event, removeAll() {} },
      webNavigation: {
        onCreatedNavigationTarget: capture('navigationTarget'),
        onCommitted: capture('committed'),
        onErrorOccurred: capture('navigationError')
      },
      storage: { local: { async get() { return {}; }, async remove() {} } },
      commands: { onCommand: event },
      tabGroups: { onRemoved: event },
      tabs: {
        onCreated: capture('created'), onRemoved: capture('removed'),
        async get(id) {
          const tab = tabs.find(tab => tab.id === id);
          if (!tab) throw new Error(`No tab with id: ${id}`);
          return { ...tab };
        },
        async create(properties) {
          calls.created.push({ ...properties });
          if (properties.active) tabs.forEach(tab => { tab.active = false; });
          const tab = {
            id: nextId++, groupId: -1, pinned: false,
            url: 'chrome://newtab/', ...properties
          };
          tabs.splice(properties.index ?? tabs.length, 0, tab);
          reindex();
          return { ...tab };
        },
        async remove(id) {
          calls.removed.push(id);
          tabs = tabs.filter(tab => tab.id !== id);
          reindex();
        },
        async query(filter) {
          return tabs.filter(tab => Object.entries(filter).every(([key, value]) => tab[key] === value))
            .map(tab => ({ ...tab }));
        },
        async group({ tabIds, groupId }) {
          tabs.find(tab => tab.id === tabIds).groupId = groupId;
        },
        async ungroup(id) { tabs.find(tab => tab.id === id).groupId = -1; },
        async move(id, { index }) {
          const [tab] = tabs.splice(tabs.findIndex(tab => tab.id === id), 1);
          tabs.splice(index, 0, tab);
          reindex();
        }
      }
    }
  });
  vm.runInContext(readFileSync(require.resolve('../service_worker.js'), 'utf8'), context);
  const flush = async () => {
    while (vm.runInContext('windowQueues.size', context)) {
      await Promise.all(vm.runInContext('[...windowQueues.values()]', context));
    }
  };
  return {
    run: code => vm.runInContext(code, context),
    ids: () => tabs.map(tab => tab.id),
    tabs: () => tabs.map(tab => ({ ...tab })),
    calls,
    emit: (name, details) => listeners[name](details),
    flush,
    async commit(id, transitionType = 'link', extra = {}) {
      listeners.committed({ tabId: id, frameId: 0, transitionType, transitionQualifiers: [], ...extra });
      await flush();
    }
  };
}

test('three rapidly opened links retain opening order', async () => {
  const h = harness([{ id: 1 }, ...[4, 3, 2].map(id => ({ id, openerTabId: 1 }))]);
  h.run('[2, 3, 4].forEach(id => pendingCreatedTabs.add(id))');
  for (const id of [2, 3, 4]) {
    await h.run(`moveNextToOpener(${id}, 1)`);
    h.run(`pendingCreatedTabs.delete(${id})`);
  }
  assert.deepEqual(h.ids(), [1, 2, 3, 4]);
});

test('extension-created links follow their opener and existing children in opening order', async () => {
  const h = harness([
    { id: 10, pinned: true },
    { id: 11 },
    { id: 1, active: true, groupId: 7, url: 'https://app.notion.com/page' },
    ...[4, 3, 2].map(id => ({ id, active: false, openerTabId: 1, url: `https://example.com/${id}` })),
    { id: 9, active: false, openerTabId: 1, groupId: 7, url: 'https://example.com/older' }
  ]);
  h.run('[2, 3, 4].forEach(id => pendingCreatedTabs.add(id))');
  for (const id of [2, 3, 4]) {
    h.emit('created', { ...h.tabs().find(tab => tab.id === id), url: '', pendingUrl: `https://example.com/${id}` });
    await h.flush();
    await h.commit(id);
    h.run(`pendingCreatedTabs.delete(${id})`);
  }
  assert.deepEqual(h.ids(), [10, 11, 1, 9, 2, 3, 4]);
  assert.deepEqual(h.tabs().filter(tab => tab.active).map(tab => tab.id), [1]);
  for (const id of [2, 3, 4]) assert.equal(h.tabs().find(tab => tab.id === id).groupId, 7);
});

test('an adjacent extension-created link follows existing children instead of acting as a duplicate', async () => {
  const h = harness([
    { id: 1, groupId: 7, url: 'https://app.notion.com/page' },
    { id: 3, openerTabId: 1, url: 'https://example.com/new' },
    { id: 2, groupId: 7, openerTabId: 1, url: 'https://example.com/older' }
  ]);
  h.emit('created', { ...h.tabs().find(tab => tab.id === 3), url: '', pendingUrl: 'https://example.com/new' });
  await h.flush();
  await h.commit(3);
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.equal(h.tabs()[2].groupId, 7);
});

test('a same-URL duplicate stays immediately below its opener', async () => {
  const h = harness([
    { id: 1, groupId: 7, url: 'https://example.com/page' },
    { id: 2, groupId: 7, openerTabId: 1, url: 'https://example.com/child' },
    { id: 3, openerTabId: 1, url: 'https://example.com/page' }
  ]);
  await h.run('placeCreatedTab({ id: 3, windowId: 1, url: "https://example.com/page" })');
  assert.deepEqual(h.ids(), [1, 3, 2]);
});

test('existing grouped children remain ahead of the new link after worker restart', async () => {
  const h = harness([
    { id: 1, groupId: 7 }, { id: 4, openerTabId: 1 },
    { id: 2, openerTabId: 1, groupId: 7 }, { id: 3, openerTabId: 1, groupId: 7 }
  ]);
  await h.run('moveNextToOpener(4, 1)');
  assert.deepEqual(h.ids(), [1, 2, 3, 4]);
});

test('closed children and children in other groups do not act as anchors', async () => {
  const h = harness([
    { id: 1 }, { id: 4 }, { id: 2, openerTabId: 1 },
    { id: 5, openerTabId: 1, groupId: 8 }
  ]);
  h.run('linkSources.set(3, 1); linkSources.set(4, 1)');
  await h.run('moveNextToOpener(4, 1)');
  assert.deepEqual(h.ids(), [1, 2, 4, 5]);
});

test('pinned source links follow existing children', async () => {
  const h = harness([
    { id: 1, pinned: true }, { id: 4 },
    { id: 2, openerTabId: 1 }, { id: 3, openerTabId: 1 }
  ]);
  await h.run('moveNextToOpener(4, 1)');
  assert.deepEqual(h.ids(), [1, 2, 3, 4]);
});

test('duplicates still go immediately after the source', async () => {
  const h = harness([{ id: 1 }, { id: 2, openerTabId: 1 }, { id: 3 }]);
  await h.run('moveNextToOpener(3, 1, { append: false })');
  assert.deepEqual(h.ids(), [1, 3, 2]);
});

for (const url of ['chrome://newtab/', 'https://example.com/from-external-app']) {
  test(`new active tab keeps its identity and URL when moved: ${url}`, async () => {
    const h = harness([
      { id: 1, pinned: true }, { id: 2, pinned: true },
      { id: 3, active: false }, { id: 4, active: true, url }
    ]);
    await h.run('placeCreatedTab({ id: 4, windowId: 1 })');
    assert.deepEqual(h.ids(), [1, 2, 4, 3]);
    const original = h.tabs().find(tab => tab.id === 4);
    assert.equal(original.url, url);
    assert.equal(original.active, true);
    assert.deepEqual(h.calls, { created: [], removed: [] });
  });
}

test('an external tab awaiting activation moves without changing the active tab', async () => {
  const h = harness([
    { id: 1, pinned: true }, { id: 2, active: true },
    { id: 3, active: false, status: 'loading', pendingUrl: 'https://example.com/' }
  ]);
  await h.run('placeCreatedTab({ id: 3, windowId: 1 })');
  assert.deepEqual(h.ids(), [1, 3, 2]);
  assert.deepEqual(h.tabs().filter(tab => tab.active).map(tab => tab.id), [2]);
  assert.deepEqual(h.calls, { created: [], removed: [] });
});

test('rapid new tabs retain their identities and the newest remains active', async () => {
  const h = harness([
    { id: 1 }, { id: 2, active: false, url: 'chrome://newtab/' },
    { id: 3, active: true, url: 'chrome://newtab/' }
  ]);
  await h.run('placeCreatedTab({ id: 2, windowId: 1 })');
  await h.run('placeCreatedTab({ id: 3, windowId: 1 })');
  assert.deepEqual(h.ids(), [3, 2, 1]);
  assert.deepEqual(h.tabs().filter(tab => tab.active).map(tab => tab.id), [3]);
  assert.deepEqual(h.calls, { created: [], removed: [] });
});

test('a new grouped tab is ungrouped and moved without replacing it', async () => {
  const h = harness([{ id: 1 }, { id: 2, active: true, groupId: 7 }]);
  await h.run('placeCreatedTab({ id: 2, windowId: 1 })');
  assert.deepEqual(h.ids(), [2, 1]);
  assert.equal(h.tabs()[0].groupId, -1);
  assert.deepEqual(h.calls, { created: [], removed: [] });
});

test('startup restore preserves the active tab and its group', async () => {
  const h = harness([
    { id: 1 }, { id: 2, active: true, groupId: 7, status: 'complete' }
  ]);
  await h.run('placeCreatedTab({ id: 2, windowId: 1 }, { preserveAsStartupRestore: true })');
  assert.deepEqual(h.ids(), [1, 2]);
  assert.equal(h.tabs()[1].groupId, 7);
  assert.deepEqual(h.calls, { created: [], removed: [] });
});

test('the dedicated shortcut still creates one tab directly below pinned tabs', async () => {
  const h = harness([{ id: 1, pinned: true }, { id: 2, active: true }]);
  await h.run('createNewTabAtTop(1)');
  await h.run('placeCreatedTab({ id: 3, windowId: 1 })');
  assert.deepEqual(h.ids(), [1, 3, 2]);
  assert.deepEqual(h.calls.created, [{ active: true, index: 1, windowId: 1 }]);
  assert.deepEqual(h.calls.removed, []);
  assert.deepEqual(h.tabs().filter(tab => tab.active).map(tab => tab.id), [3]);
});

for (const active of [true, false]) {
  for (const commitBeforePlacement of [true, false]) {
    test(`external URL with a grouped opener stays at the top (active=${active}, early commit=${commitBeforePlacement})`, async () => {
      const h = harness([
        { id: 1, pinned: true, url: 'https://mail.google.com/' },
        { id: 2, url: 'https://example.com/other' },
        { id: 3, groupId: 7, openerTabId: 1, url: 'https://example.com/from-gmail' },
        { id: 4, groupId: 7, openerTabId: 3, active, status: 'loading', url: '', pendingUrl: 'https://example.com/external' }
      ]);
      h.emit('created', h.tabs().find(tab => tab.id === 4));
      if (!commitBeforePlacement) await h.flush();
      await h.commit(4, 'start_page');
      assert.deepEqual(h.ids(), [1, 4, 2, 3]);
      assert.equal(h.tabs()[1].groupId, -1);
      assert.equal(h.tabs()[1].active, active);
      assert.equal(h.run('autoGroupCandidates.size'), 0);
      assert.deepEqual(h.calls, { created: [], removed: [] });
      // A later page navigation must not reuse the old opener.
      await h.commit(4, 'link');
      assert.deepEqual(h.ids(), [1, 4, 2, 3]);
    });
  }
}

test('an external URL matching its opener is not a duplicate', async () => {
  const h = harness([
    { id: 1, pinned: true }, { id: 2 },
    { id: 3, groupId: 7, url: 'https://example.com/page' },
    { id: 4, active: true, openerTabId: 3, url: 'https://example.com/page' }
  ]);
  // The page can finish loading before the onCreated task runs. Use its
  // original pending URL, not its later URL, to distinguish it from a copy.
  h.emit('created', { ...h.tabs()[3], url: '', pendingUrl: 'https://example.com/page' });
  await h.commit(4, 'start_page');
  assert.deepEqual(h.ids(), [1, 4, 2, 3]);
  assert.equal(h.tabs()[1].groupId, -1);
  assert.equal(h.run('autoGroupCandidates.size'), 0);
});

for (const url of ['chrome://newtab/', 'chrome://new-tab-page/', 'about:blank']) {
  test(`a blank tab with an opener stays at the top: ${url}`, async () => {
    const h = harness([
      { id: 1 }, { id: 2, groupId: 7, url: 'https://example.com/from-gmail' },
      { id: 3, groupId: 7, openerTabId: 2, active: true, url }
    ]);
    h.emit('created', h.tabs()[2]);
    await h.flush();
    await h.commit(3, 'link');
    assert.deepEqual(h.ids(), [3, 1, 2]);
    assert.equal(h.tabs()[0].groupId, -1);
  });
}

test('a genuine browser link uses its navigation source before the page loads', async () => {
  const h = harness([
    { id: 1 }, { id: 2, groupId: 7, url: 'https://example.com/source' },
    { id: 3, active: false, pendingUrl: 'https://example.com/link' }
  ]);
  h.emit('created', h.tabs()[2]);
  h.emit('navigationTarget', { tabId: 3, sourceTabId: 2 });
  await h.flush();
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.equal(h.tabs()[2].groupId, 7);
  await h.commit(3, 'link');
  assert.deepEqual(h.ids(), [1, 2, 3]);
});

test('extension links keep opening order when the pages commit in reverse order', async () => {
  const h = harness([
    { id: 10, pinned: true }, { id: 11 },
    { id: 1, groupId: 7, url: 'https://app.notion.com/page' },
    { id: 9, groupId: 7, openerTabId: 1, url: 'https://example.com/old' },
    ...[2, 3, 4].map(id => ({ id, openerTabId: 1, active: id === 4, url: '', pendingUrl: `https://example.com/${id}` }))
  ]);
  for (const id of [2, 3, 4]) h.emit('created', h.tabs().find(tab => tab.id === id));
  await h.flush();
  for (const id of [4, 3, 2]) await h.commit(id);
  assert.deepEqual(h.ids(), [10, 11, 1, 9, 2, 3, 4]);
  for (const id of [2, 3, 4]) assert.equal(h.tabs().find(tab => tab.id === id).groupId, 7);
  assert.deepEqual(h.tabs().filter(tab => tab.active).map(tab => tab.id), [4]);
});

test('a link commit received before placement still uses the opener', async () => {
  const h = harness([
    { id: 1 }, { id: 2, groupId: 7, url: 'https://app.notion.com/page' },
    { id: 3, openerTabId: 2, active: true, pendingUrl: 'https://example.com/link' }
  ]);
  h.emit('created', h.tabs()[2]);
  await h.commit(3);
  assert.deepEqual(h.ids(), [1, 2, 3]);
  assert.equal(h.tabs()[2].groupId, 7);
});

test('subframe commits do not classify a new external tab as a link', async () => {
  const h = harness([
    { id: 1, groupId: 7, url: 'https://example.com/source' },
    { id: 2, openerTabId: 1, pendingUrl: 'https://example.com/external' }
  ]);
  h.emit('created', h.tabs()[1]);
  await h.commit(2, 'link', { frameId: 5 });
  await h.commit(2, 'start_page');
  assert.deepEqual(h.ids(), [2, 1]);
  assert.equal(h.tabs()[0].groupId, -1);
});

test('an external tab is not used as an existing child of pinned Gmail', async () => {
  const h = harness([
    { id: 1, pinned: true, url: 'https://mail.google.com/' },
    { id: 2 }, { id: 3, openerTabId: 1, pendingUrl: 'https://example.com/external' },
    { id: 4, pendingUrl: 'https://example.com/gmail-link' }
  ]);
  h.emit('created', h.tabs().find(tab => tab.id === 3));
  await h.commit(3, 'start_page');
  h.emit('created', h.tabs().find(tab => tab.id === 4));
  h.emit('navigationTarget', { tabId: 4, sourceTabId: 1 });
  await h.flush();
  assert.deepEqual(h.ids(), [1, 4, 3, 2]);
});

test('startup restore is not changed by a later commit event', async () => {
  const h = harness([
    { id: 1, groupId: 7, url: 'https://example.com/source' },
    { id: 2, groupId: 7, openerTabId: 1, url: 'https://example.com/restored', status: 'complete' }
  ]);
  h.run('startupRestoreGuardUntil = Date.now() + 15000');
  h.emit('created', h.tabs()[1]);
  await h.commit(2);
  assert.deepEqual(h.ids(), [1, 2]);
  assert.equal(h.tabs()[1].groupId, 7);
});

for (const failBeforePlacement of [true, false]) {
  test(`a failed external navigation cannot use a later link (early error=${failBeforePlacement})`, async () => {
    const h = harness([
      { id: 1, groupId: 7, url: 'https://example.com/source' },
      { id: 2, openerTabId: 1, pendingUrl: 'https://example.com/external' }
    ]);
    h.emit('created', h.tabs()[1]);
    if (!failBeforePlacement) await h.flush();
    h.emit('navigationError', { tabId: 2, frameId: 0 });
    await h.commit(2, 'link');
    assert.deepEqual(h.ids(), [2, 1]);
    assert.equal(h.tabs()[0].groupId, -1);
  });
}

test('address-bar navigation does not confirm an inherited opener', async () => {
  const h = harness([
    { id: 1, groupId: 7, url: 'https://example.com/source' },
    { id: 2, openerTabId: 1, pendingUrl: 'https://example.com/external' }
  ]);
  h.emit('created', h.tabs()[1]);
  await h.commit(2, 'link', { transitionQualifiers: ['from_address_bar'] });
  assert.deepEqual(h.ids(), [2, 1]);
  assert.equal(h.tabs()[0].groupId, -1);
});
