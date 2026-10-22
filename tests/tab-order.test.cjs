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
      webNavigation: { onCreatedNavigationTarget: event },
      commands: { onCommand: event },
      tabGroups: { onRemoved: event },
      tabs: {
        onCreated: event, onRemoved: event,
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
  return {
    run: code => vm.runInContext(code, context),
    ids: () => tabs.map(tab => tab.id),
    tabs: () => tabs.map(tab => ({ ...tab })),
    calls
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
