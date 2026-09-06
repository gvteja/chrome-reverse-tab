const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function harness(initial) {
  let tabs = initial.map(tab => ({ windowId: 1, groupId: -1, pinned: false, ...tab }));
  const reindex = () => tabs.forEach((tab, index) => { tab.index = index; });
  reindex();
  const event = { addListener() {} };
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    chrome: {
      runtime: { onStartup: event, onInstalled: event, onMessage: event },
      contextMenus: { onClicked: event, removeAll() {} },
      webNavigation: { onCreatedNavigationTarget: event },
      commands: { onCommand: event },
      tabGroups: { onRemoved: event },
      tabs: {
        onCreated: event, onRemoved: event,
        async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
        async query(filter) {
          return tabs.filter(tab => Object.entries(filter).every(([key, value]) => tab[key] === value))
            .map(tab => ({ ...tab }));
        },
        async group({ tabIds, groupId }) {
          tabs.find(tab => tab.id === tabIds).groupId = groupId;
        },
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
    ids: () => tabs.map(tab => tab.id)
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
