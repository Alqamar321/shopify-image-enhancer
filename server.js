// Al Qamar — Shopify product image enhancer
// 1) New products: Shopify "Product creation" webhook -> enhance main image -> review queue (or auto-apply)
// 2) Existing products: /batch?collection=<handle>&limit=20 -> same flow, one collection at a time
// 3) /review page: approve / reject each enhanced image side by side with the original
import express from 'express';
import crypto from 'crypto';
import { enhanceImage } from './enhance.js';
import {
  getProduct, getCollectionProducts, uploadImageFile, getFileUrl,
  setPending, applyImage, rejectImage, restoreOriginal, listPending, sleep,
} from './shopify.js';

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY;
const AUTO_APPLY = process.env.AUTO_APPLY === 'true';
const WEBHOOK_DELAY_SEC = Number(process.env.WEBHOOK_DELAY_SEC || 120);
const PAUSED = process.env.PAUSED === 'true'; // pause switch: no webhook or batch processing
const SKIP_TAGS = ['img-enhanced', 'img-pending', 'img-rejected', 'img-skip'];

// ---------- simple job queue (one image at a time) ----------
const queue = [];
const log = [];
let running = false;
let stats = { done: 0, failed: 0, skipped: 0 };

function addLog(msg) {
  const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${msg}`;
  console.log(line);
  log.unshift(line);
  if (log.length > 300) log.pop();
}

function enqueue(productId) {
  if (!queue.includes(productId)) queue.push(productId);
  runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try { await processProduct(id); }
    catch (e) {
      stats.failed++;
      addLog(`FAILED ${id}: ${e.message}`);
      // Billing / quota / bad key problems affect every product — stop instead of burning through the queue
      if (/credits|quota|billing|401|Incorrect API key/i.test(e.message)) {
        addLog(`STOPPED: OpenAI account problem — ${queue.length} products left unprocessed. Fix it, then re-run the batch link.`);
        queue.length = 0;
      }
    }
    await sleep(1000);
  }
  running = false;
}

async function processProduct(productId) {
  const p = await getProduct(productId);
  if (!p) { stats.skipped++; return addLog(`skip ${productId}: not found`); }
  if (p.tags.some((t) => SKIP_TAGS.includes(t))) { stats.skipped++; return addLog(`skip "${p.title}": already processed`); }
  const srcUrl = p.featuredMedia?.image?.url;
  if (!srcUrl) { stats.skipped++; return addLog(`skip "${p.title}": no image`); }

  addLog(`enhancing "${p.title}"...`);
  const png = await enhanceImage(srcUrl);
  const { fileId } = await uploadImageFile(png, `${p.handle}-ai.png`, p.title);
  await setPending(p.id, fileId, p.featuredMedia.id);
  if (AUTO_APPLY) {
    await applyImage(p.id, fileId);
    addLog(`APPLIED "${p.title}"`);
  } else {
    addLog(`ready for review "${p.title}"`);
  }
  stats.done++;
}

// ---------- auth for admin pages ----------
function requireKey(req, res, next) {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  next();
}

// ---------- webhook: product created ----------
app.post('/webhooks/product-create', express.raw({ type: '*/*' }), (req, res) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET || '')
    .update(req.body).digest('base64');
  const ok = hmac.length === digest.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
  if (!ok) return res.status(401).send('bad hmac');
  res.status(200).send('ok');

  const body = JSON.parse(req.body.toString('utf8'));
  if (PAUSED) return addLog(`PAUSED: ignored new product "${body.title}"`);
  const id = body.admin_graphql_api_id || `gid://shopify/Product/${body.id}`;
  addLog(`webhook: new product "${body.title}" — waiting ${WEBHOOK_DELAY_SEC}s for images`);
  setTimeout(() => enqueue(id), WEBHOOK_DELAY_SEC * 1000);
});

app.use(express.urlencoded({ extended: false }));

// ---------- batch: existing products in a collection ----------
app.get('/batch', requireKey, async (req, res) => {
  const handle = req.query.collection;
  const limit = Number(req.query.limit || 20);
  if (PAUSED) return res.status(503).send('Enhancer is PAUSED (Render env PAUSED=true). Set it to false to run batches.');
  if (!handle) return res.status(400).send('Add ?collection=<collection-handle>');
  try {
    const all = await getCollectionProducts(handle);
    const todo = all.filter((p) => p.featuredMedia && !p.tags.some((t) => SKIP_TAGS.includes(t))).slice(0, limit);
    todo.forEach((p) => enqueue(p.id));
    addLog(`batch "${handle}": queued ${todo.length} of ${all.length} products`);
    res.send(`Queued ${todo.length} products from "${handle}" (${all.length} in collection). <a href="/status?key=${ADMIN_KEY}">View status</a>`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Stop: clears everything still waiting. The image being processed right now finishes (already paid for).
app.get('/stop', requireKey, (req, res) => {
  const n = queue.length;
  queue.length = 0;
  addLog(`STOPPED by user — ${n} queued products removed`);
  res.send(`Stopped. ${n} queued products removed. <a href="/status?key=${ADMIN_KEY}">View status</a>`);
});

app.get('/status', requireKey, (req, res) => {
  res.type('html').send(`<meta http-equiv="refresh" content="10"><body style="font-family:sans-serif">
    <h2>Image enhancer status</h2>
    <p>Mode: <b>${PAUSED ? 'PAUSED' : AUTO_APPLY ? 'AUTO-APPLY' : 'REVIEW'}</b> &nbsp; Queue: <b>${queue.length}</b> &nbsp; Running: <b>${running}</b>
    &nbsp; Done: ${stats.done} &nbsp; Failed: ${stats.failed} &nbsp; Skipped: ${stats.skipped}</p>
    <p><a href="/review?key=${ADMIN_KEY}">Open review page</a> &nbsp;|&nbsp;
      <a href="/stop?key=${ADMIN_KEY}" style="color:#cf222e;font-weight:bold">STOP batch</a></p>
    <form action="/batch" method="get" style="background:#f4f4f4;padding:10px;border-radius:6px">
      <input type="hidden" name="key" value="${ADMIN_KEY}">
      Run collection: <input name="collection" placeholder="collection handle, e.g. other-tools" size="30">
      Limit: <input name="limit" value="20" size="4">
      <button>Start</button></form>
    <pre style="background:#f4f4f4;padding:10px">${log.join('\n')}</pre></body>`);
});

// ---------- review page ----------
app.get('/review', requireKey, async (req, res) => {
  try {
    const items = await listPending();
    const cards = await Promise.all(items.map(async (p) => {
      const aiUrl = p.pending?.value ? await getFileUrl(p.pending.value) : null;
      const orig = p.media.nodes.find((m) => m.id === p.original?.value) || p.media.nodes[0];
      return `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">
        <b>${p.title}</b><br>
        <div style="display:flex;gap:12px;margin:8px 0">
          <div><small>Original</small><br><img src="${orig?.image?.url || ''}" width="300"></div>
          <div><small>AI enhanced</small><br><img src="${aiUrl || ''}" width="300"></div>
        </div>
        <form method="post" action="/approve?key=${ADMIN_KEY}" style="display:inline">
          <input type="hidden" name="id" value="${p.id}"><input type="hidden" name="file" value="${p.pending?.value}">
          <button style="background:#1a7f37;color:#fff;padding:8px 18px;border:0;border-radius:6px">Approve</button></form>
        <form method="post" action="/reject?key=${ADMIN_KEY}" style="display:inline">
          <input type="hidden" name="id" value="${p.id}"><input type="hidden" name="file" value="${p.pending?.value}">
          <button style="background:#cf222e;color:#fff;padding:8px 18px;border:0;border-radius:6px">Reject</button></form>
      </div>`;
    }));
    res.type('html').send(`<body style="font-family:sans-serif;max-width:720px;margin:auto">
      <h2>Review AI images (${items.length} pending)</h2>
      <p><a href="/status?key=${ADMIN_KEY}">Status</a></p>${cards.join('') || '<p>Nothing to review.</p>'}</body>`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/approve', requireKey, async (req, res) => {
  try { await applyImage(req.body.id, req.body.file); addLog(`approved ${req.body.id}`); }
  catch (e) { addLog(`approve failed ${req.body.id}: ${e.message}`); }
  res.redirect(`/review?key=${ADMIN_KEY}`);
});

app.post('/reject', requireKey, async (req, res) => {
  try { await rejectImage(req.body.id, req.body.file); addLog(`rejected ${req.body.id}`); }
  catch (e) { addLog(`reject failed ${req.body.id}: ${e.message}`); }
  res.redirect(`/review?key=${ADMIN_KEY}`);
});

// Undo an already-applied image: /restore?key=...&product=<numeric id>
app.get('/restore', requireKey, async (req, res) => {
  const id = `gid://shopify/Product/${req.query.product}`;
  try { await restoreOriginal(id); addLog(`restored original ${id}`); res.send('Original image restored.'); }
  catch (e) { res.status(500).send(e.message); }
});

app.get('/', (req, res) => res.send('Al Qamar image enhancer is running.'));

// Optional: queue a batch automatically on boot, e.g. STARTUP_BATCH="other-tools:5"
// (lets a batch be started from Render's Environment settings without opening /batch).
// Products already processed are skipped by their tags, so a restart never re-charges them.
async function startupBatch() {
  const spec = (process.env.STARTUP_BATCH || '').trim();
  if (!spec || PAUSED) return;
  const [handle, lim] = spec.split(':');
  try {
    const all = await getCollectionProducts(handle);
    const todo = all.filter((p) => p.featuredMedia && !p.tags.some((t) => SKIP_TAGS.includes(t))).slice(0, Number(lim || 20));
    todo.forEach((p) => enqueue(p.id));
    addLog(`startup batch "${handle}": queued ${todo.length} of ${all.length} products`);
  } catch (e) { addLog(`startup batch failed: ${e.message}`); }
}

// Render free plan sleeps after ~15 min without incoming requests — ping ourselves while a batch is running.
setInterval(() => {
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self && (running || queue.length)) fetch(self).catch(() => {});
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  addLog(`server on :${PORT} (mode: ${PAUSED ? 'PAUSED' : AUTO_APPLY ? 'auto-apply' : 'review'})`);
  startupBatch();
});
