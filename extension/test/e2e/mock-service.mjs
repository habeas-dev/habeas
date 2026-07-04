// A tiny fake service for end-to-end testing: a logged-in SPA that sends a real-looking JWT to
// its own API (so the extension's in-session hook captures it), plus a paginated receipts API and
// a PDF endpoint. Loopback http — the runtime validator allows http only for localhost.
import http from 'node:http';

const RECEIPTS = [
  { id: 'R1', date: '2026-05-01', total: 10.5, shop: 'Mock Store', kind: 'FOOD', channel: 'store' },
  { id: 'R2', date: '2026-05-02', total: 20, shop: 'Mock Store', kind: 'FOOD', channel: 'store' },
  { id: 'R3', date: '2026-05-03', total: 5, shop: 'Mock Gas', kind: 'FUEL', channel: 'store' },
];
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

// The SPA re-fetches a few times: the extension injects its hook (an async external script) at
// document_start, which may land after the first call — a real SPA fetches on navigation anyway.
const SPA = `<!doctype html><html><body><h1 id="t">loading</h1><script>
function go(){return fetch('/api/list?o=0&count=50',{headers:{authorization:'bearer eyJTESTtoken.abc.def','x-csrf-token':'csrf1'}})
  .then(r=>r.json()).then(d=>{document.getElementById('t').textContent='loaded '+d.receipts.length;}).catch(e=>{});}
go(); var n=0; var iv=setInterval(function(){ if(++n>8){clearInterval(iv);return;} go(); }, 500);
</script></body></html>`;

export function startMockService() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(SPA); }
      if (u.pathname === '/api/list') {
        // Require the replayed auth to prove capture worked (mimics a real gated API).
        if (!/eyJ/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end('no token'); }
        const o = Number(u.searchParams.get('o')) || 0;
        const page = RECEIPTS.slice(o, o + 50);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ receipts: page, offsets: { o: o + page.length } }));
      }
      if (u.pathname.startsWith('/api/pdf/')) {
        if (!/eyJ/.test(req.headers.authorization || '')) { res.writeHead(401); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF);
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, count: RECEIPTS.length }));
  });
}
