# Shopify Image Enhancer — Al Qamar

Turns product photos into clean white-background studio images using OpenAI's image model, for new and existing products.

## How it works
- **New products:** Shopify "Product creation" webhook → waits 2 min (so images finish uploading) → enhances the main image → review queue.
- **Existing products:** open `/batch?key=ADMIN_KEY&collection=<handle>&limit=20` → queues products from that collection.
- **Review:** `/review?key=ADMIN_KEY` shows original vs AI side by side → Approve (AI image becomes the main image, original stays in the gallery) or Reject (AI image deleted).
- **Undo:** `/restore?key=ADMIN_KEY&product=<numeric product id>` puts the original back first.
- **Status / log:** `/status?key=ADMIN_KEY`

Tags used: `img-pending`, `img-enhanced`, `img-rejected`. Add `img-skip` to any product you never want touched.

## Environment variables (Render → Environment)
| Name | Value |
|---|---|
| `OPENAI_API_KEY` | your OpenAI API key |
| `SHOPIFY_STORE` | `xxxx.myshopify.com` |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | from the Shopify Dev Dashboard app (or set `SHOPIFY_ADMIN_TOKEN` instead) |
| `SHOPIFY_WEBHOOK_SECRET` | the signing secret shown under Settings → Notifications → Webhooks |
| `ADMIN_KEY` | any long password you choose (protects the review/batch pages) |
| `AUTO_APPLY` | `false` (review mode). Set `true` only after testing. |
| `OPENAI_IMAGE_MODEL` | optional, default `gpt-image-2.5-sunburst` |
| `WEBHOOK_DELAY_SEC` | optional, default `120` |
| `STARTUP_BATCH` | optional, e.g. `other-tools:5` — queues that collection on boot (clear it after the run) |

Shopify app scopes needed: `read_products`, `write_products`, `read_files`, `write_files`.

## Render
- Build command: `npm install`
- Start command: `npm start`
