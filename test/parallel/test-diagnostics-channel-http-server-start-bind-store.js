'use strict';

const common = require('../common');
const assert = require('assert');
const { AsyncLocalStorage } = require('async_hooks');
const dc = require('diagnostics_channel');
const http = require('http');

const als = new AsyncLocalStorage();
const channel = dc.channel('http.server.request.start');

let nextId = 0;
channel.bindStore(als, (message) => ({ id: ++nextId, request: message.request }));

channel.subscribe(common.mustCall((message) => {
  // Stores are entered before subscribers are notified.
  assert.strictEqual(als.getStore().request, message.request);
}, 2));

const server = http.createServer({ keepAlive: true }, common.mustCall((req, res) => {
  const store = als.getStore();
  assert.strictEqual(store.request, req);
  assert.strictEqual(store.id, Number(req.url.slice(1)));

  setImmediate(common.mustCall(() => {
    assert.strictEqual(als.getStore(), store);
    res.end(String(store.id));
  }));
}, 2));

server.listen(0, common.mustCall(async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const { port } = server.address();

  for (const id of [1, 2]) {
    const body = await new Promise((resolve, reject) => {
      http.get({ port, path: `/${id}`, agent }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.strictEqual(body, String(id));
  }

  assert.strictEqual(als.getStore(), undefined);
  agent.destroy();
  server.close();
}));
