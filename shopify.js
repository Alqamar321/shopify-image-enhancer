// Shopify Admin GraphQL helpers
const SHOP = process.env.SHOPIFY_STORE; // e.g. alqamarshop.myshopify.com
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';

let cachedToken = null;
let tokenExpiresAt = 0;

// Uses SHOPIFY_ADMIN_TOKEN if set, otherwise the Dev Dashboard client-credentials flow.
async function getToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Shopify token error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

export async function gql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
  return json.data;
}

function userErrors(payload, label) {
  const errs = payload?.userErrors || payload?.mediaUserErrors || [];
  if (errs.length) throw new Error(`${label}: ${JSON.stringify(errs)}`);
}

export async function getProduct(id) {
  const d = await gql(`query($id: ID!) {
    product(id: $id) {
      id title handle tags
      featuredMedia { id ... on MediaImage { image { url } } }
      metafield(namespace: "custom", key: "ai_image_pending") { value }
    }
  }`, { id });
  return d.product;
}

export async function getCollectionProducts(handle) {
  const products = [];
  let after = null;
  do {
    const d = await gql(`query($handle: String!, $after: String) {
      collectionByHandle(handle: $handle) {
        products(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id title tags featuredMedia { id } }
        }
      }
    }`, { handle, after });
    if (!d.collectionByHandle) throw new Error(`Collection not found: ${handle}`);
    const conn = d.collectionByHandle.products;
    products.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return products;
}

// Upload PNG bytes to Shopify Files; returns the new MediaImage id once ready.
export async function uploadImageFile(pngBuffer, filename, alt) {
  const s = await gql(`mutation($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }`, { input: [{ resource: 'IMAGE', filename, mimeType: 'image/png', httpMethod: 'POST', fileSize: String(pngBuffer.length) }] });
  userErrors(s.stagedUploadsCreate, 'stagedUploadsCreate');
  const target = s.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([pngBuffer], { type: 'image/png' }), filename);
  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Staged upload failed ${up.status}: ${await up.text()}`);

  const f = await gql(`mutation($files: [FileCreateInput!]!) {
    fileCreate(files: $files) { files { id } userErrors { field message } }
  }`, { files: [{ originalSource: target.resourceUrl, contentType: 'IMAGE', alt }] });
  userErrors(f.fileCreate, 'fileCreate');
  const fileId = f.fileCreate.files[0].id;

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const n = await gql(`query($id: ID!) { node(id: $id) { ... on MediaImage { fileStatus image { url } } } }`, { id: fileId });
    if (n.node?.fileStatus === 'READY') return { fileId, url: n.node.image.url };
    if (n.node?.fileStatus === 'FAILED') throw new Error('Shopify file processing failed');
  }
  throw new Error('Timed out waiting for Shopify file to be ready');
}

export async function getFileUrl(fileId) {
  const n = await gql(`query($id: ID!) { node(id: $id) { ... on MediaImage { image { url } } } }`, { id: fileId });
  return n.node?.image?.url || null;
}

export async function setPending(productId, fileId, originalMediaId) {
  const d = await gql(`mutation($m: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $m) { userErrors { field message } }
  }`, { m: [
    { ownerId: productId, namespace: 'custom', key: 'ai_image_pending', type: 'single_line_text_field', value: fileId },
    { ownerId: productId, namespace: 'custom', key: 'ai_image_original', type: 'single_line_text_field', value: originalMediaId || 'none' },
  ] });
  userErrors(d.metafieldsSet, 'metafieldsSet');
  await tags(productId, ['img-pending'], []);
}

// Attach the AI image to the product as the main (first) image.
// The old main image is taken off the product (KEEP_ORIGINAL=true keeps it in the gallery instead);
// it stays in Shopify Files, so /restore can put it back.
export async function applyImage(productId, fileId) {
  const u = await gql(`mutation($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) { userErrors { field message } }
  }`, { files: [{ id: fileId, referencesToAdd: [productId] }] });
  userErrors(u.fileUpdate, 'fileUpdate');
  await sleep(1500);
  const r = await gql(`mutation($id: ID!, $moves: [MoveInput!]!) {
    productReorderMedia(id: $id, moves: $moves) { mediaUserErrors { field message } }
  }`, { id: productId, moves: [{ id: fileId, newPosition: '0' }] });
  userErrors(r.productReorderMedia, 'productReorderMedia');
  if (process.env.KEEP_ORIGINAL !== 'true') await detachOriginal(productId);
  await tags(productId, ['img-enhanced'], ['img-pending']);
}

async function detachOriginal(productId) {
  const d = await gql(`query($id: ID!) { product(id: $id) {
    original: metafield(namespace: "custom", key: "ai_image_original") { value } } }`, { id: productId });
  const origId = d.product?.original?.value;
  if (!origId || origId === 'none') return;
  const u = await gql(`mutation($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) { userErrors { field message } }
  }`, { files: [{ id: origId, referencesToRemove: [productId] }] });
  userErrors(u.fileUpdate, 'fileUpdate (remove original)');
}

export async function rejectImage(productId, fileId) {
  const d = await gql(`mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { userErrors { field message } } }`, { ids: [fileId] });
  userErrors(d.fileDelete, 'fileDelete');
  await tags(productId, ['img-rejected'], ['img-pending']);
}

// Undo an applied image: put original back first and detach the AI image.
export async function restoreOriginal(productId) {
  const d = await gql(`query($id: ID!) { product(id: $id) {
    pending: metafield(namespace: "custom", key: "ai_image_pending") { value }
    original: metafield(namespace: "custom", key: "ai_image_original") { value }
  } }`, { id: productId });
  const aiId = d.product?.pending?.value;
  const origId = d.product?.original?.value;
  if (origId && origId !== 'none') {
    // re-attach first if it was removed on approve
    const m = await gql(`query($id: ID!) { product(id: $id) { media(first: 50) { nodes { id } } } }`, { id: productId });
    if (!m.product.media.nodes.some((n) => n.id === origId)) {
      const a = await gql(`mutation($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) { userErrors { field message } }
      }`, { files: [{ id: origId, referencesToAdd: [productId] }] });
      userErrors(a.fileUpdate, 'fileUpdate (re-attach original)');
      await sleep(1500);
    }
    const r = await gql(`mutation($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) { mediaUserErrors { field message } }
    }`, { id: productId, moves: [{ id: origId, newPosition: '0' }] });
    userErrors(r.productReorderMedia, 'productReorderMedia');
  }
  if (aiId) {
    const u = await gql(`mutation($files: [FileUpdateInput!]!) {
      fileUpdate(files: $files) { userErrors { field message } }
    }`, { files: [{ id: aiId, referencesToRemove: [productId] }] });
    userErrors(u.fileUpdate, 'fileUpdate');
  }
  await tags(productId, ['img-rejected'], ['img-enhanced', 'img-pending']);
}

export async function listPending() {
  const d = await gql(`{ products(first: 50, query: "tag:img-pending") {
    nodes { id title handle
      media(first: 10) { nodes { id ... on MediaImage { image { url } } } }
      pending: metafield(namespace: "custom", key: "ai_image_pending") { value }
      original: metafield(namespace: "custom", key: "ai_image_original") { value }
    } } }`);
  return d.products.nodes;
}

async function tags(id, add, remove) {
  if (add.length) {
    const a = await gql(`mutation($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { field message } } }`, { id, t: add });
    userErrors(a.tagsAdd, 'tagsAdd');
  }
  if (remove.length) {
    const r = await gql(`mutation($id: ID!, $t: [String!]!) { tagsRemove(id: $id, tags: $t) { userErrors { field message } } }`, { id, t: remove });
    userErrors(r.tagsRemove, 'tagsRemove');
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
