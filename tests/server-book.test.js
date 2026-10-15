import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerBook } from '../extension/stores/server.js';

test('a hosted browser keeps the subpath and sends no invented bearer credential', async () => {
  const requests = [];
  let denied = false;
  const book = createServerBook({ url: 'https://electro.example/0xtagger',
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      return new Response(JSON.stringify(denied ? { detail: 'Not allowed' } : { records: [] }), { status: denied ? 401 : 200 });
    },
  });
  assert.deepEqual((await book.load()).records, []);
  assert.equal(requests[0].url, 'https://electro.example/0xtagger/tags');
  assert.equal(requests[0].headers.Authorization, undefined);
  denied = true;
  await assert.rejects(book.load(), /Tailscale identity/);
});
