// OpenAI image enhancement (ChatGPT image model via API)
import OpenAI, { toFile } from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst';

export const PROMPT = process.env.ENHANCE_PROMPT || `Professional e-commerce product photo for an online store.
Keep the EXACT same product: identical shape, colours, buttons, button labels, logos, printed text, ports and proportions.
Do not redraw, invent, add or remove any detail of the product itself.
Remove the background, price tags, price stickers, hands and clutter.
If the product is photographed inside its retail box, keep the box exactly as it is.
Place the product centred on a pure white (#FFFFFF) seamless background, soft even studio lighting,
a subtle natural shadow underneath, sharp focus, product filling about 80% of the square frame.`;

export async function enhanceImage(imageUrl) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Could not download source image (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';

  const result = await openai.images.edit({
    model: MODEL,
    image: await toFile(buf, `source.${ext}`, { type }),
    prompt: PROMPT,
    size: '1024x1024',
    quality: process.env.OPENAI_IMAGE_QUALITY || 'high',
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return Buffer.from(b64, 'base64');
}
