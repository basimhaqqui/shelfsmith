import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'us-east-1';
const STACK = 'ShelfSmithStack';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Resolve the table name from the deployed stack so nothing is hardcoded.
// Override with TABLE_NAME=... if you want to target a different table.
async function resolveTableName(): Promise<string> {
  if (process.env.TABLE_NAME) return process.env.TABLE_NAME;
  const cf = new CloudFormationClient({ region: REGION });
  const res = await cf.send(new DescribeStacksCommand({ StackName: STACK }));
  const name = res.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'TableName')?.OutputValue;
  if (!name) throw new Error(`Could not find TableName output on ${STACK}. Is it deployed?`);
  return name;
}

interface ProductSeed {
  id: string;
  title: string;
  specs: string;
  category: string;
  reviews: { rating: number; author: string; text: string }[];
}

// A few products spanning the catalog, each with reviews that share recurring
// themes (battery life, build quality, connectivity) so the digest has signal.
const PRODUCTS: ProductSeed[] = [
  {
    id: 'aerobass-x2',
    title: 'AeroBass X2 Wireless Earbuds',
    specs: 'Bluetooth 5.3, ANC, 8h battery + 24h case, IPX5, USB-C',
    category: 'Wireless Earbuds',
    reviews: [
      { rating: 5, author: 'Marcus T.', text: 'Sound quality is incredible for the price, deep bass and clear highs. Noise cancelling actually works on the train.' },
      { rating: 2, author: 'Priya K.', text: 'Great sound but the battery dies way before the advertised 8 hours, more like 5. Disappointing.' },
      { rating: 3, author: 'Dan W.', text: 'Love the audio, but they keep disconnecting from my phone randomly. Connectivity is flaky.' },
      { rating: 4, author: 'Sofia R.', text: 'Comfortable fit and rich sound. Battery is just okay, but the case charges fast.' },
    ],
  },
  {
    id: 'thunderpod-mini',
    title: 'ThunderPod Mini Bluetooth Speaker',
    specs: '10W, Bluetooth 5.0, 12h battery, IP67 waterproof, 200g',
    category: 'Portable Speakers',
    reviews: [
      { rating: 5, author: 'Jenna L.', text: 'Tiny but LOUD. Took it to the beach, fully waterproof and the battery lasted all day.' },
      { rating: 4, author: 'Omar F.', text: 'Solid sound for the size and the battery life is genuinely 12 hours. Bass is a little weak.' },
      { rating: 2, author: 'Chris P.', text: 'Pairing is a nightmare, drops connection constantly past 15 feet. Sound is fine when it works.' },
    ],
  },
  {
    id: 'frostair-7',
    title: 'FrostAir 7L Mini Fridge',
    specs: '7 liter, thermoelectric cooling, 12V car + 110V home, quiet operation',
    category: 'Mini Fridges',
    reviews: [
      { rating: 4, author: 'Hannah B.', text: 'Perfect for my dorm and quiet enough to sleep next to. Cools drinks well but not ice-cold.' },
      { rating: 5, author: 'Leo M.', text: 'Runs off my car outlet on road trips, super convenient. Build quality feels solid.' },
      { rating: 2, author: 'Rachel S.', text: 'Cooling is weak on hot days, barely gets cold. The plastic build feels cheap and creaky.' },
      { rating: 3, author: 'Tom H.', text: 'Does the job for snacks. A bit louder than I expected and the latch feels flimsy.' },
    ],
  },
  {
    id: 'voltcharge-65',
    title: 'VoltCharge 65W GaN USB-C Charger',
    specs: '65W, 2x USB-C + 1x USB-A, GaN, foldable prongs',
    category: 'USB Chargers & Power Adapters',
    reviews: [
      { rating: 5, author: 'Aisha N.', text: 'Charges my laptop and phone at the same time at full speed. The foldable prongs are perfect for travel.' },
      { rating: 5, author: 'Greg D.', text: 'Tiny for 65W thanks to GaN. Build quality is excellent and it stays cool.' },
      { rating: 3, author: 'Nina V.', text: 'Works great but gets noticeably warm under heavy load. Otherwise a solid travel charger.' },
    ],
  },
  {
    id: 'roadeye-dashcam',
    title: 'RoadEye Dashcam Pro',
    specs: '4K, 160 degree FOV, WiFi, GPS, night vision, loop recording, 256GB max',
    category: 'Vehicle Dash Cameras',
    reviews: [
      { rating: 5, author: 'Victor C.', text: 'Crystal clear 4K footage, night vision is genuinely usable. Setup over WiFi was easy.' },
      { rating: 2, author: 'Beth A.', text: 'Video is sharp but the app connectivity is awful, the WiFi drops every time I try to download clips.' },
      { rating: 4, author: 'Sam I.', text: 'Great image quality and GPS tagging is handy. The mount build quality could be sturdier.' },
    ],
  },
];

function buildItems() {
  const now = Date.now();
  const items: Record<string, unknown>[] = [];
  PRODUCTS.forEach((p, pi) => {
    items.push({
      productId: p.id,
      sk: 'PRODUCT',
      title: p.title,
      specs: p.specs,
      category: p.category,
      seeded: true,
      createdAt: new Date(now).toISOString(),
    });
    p.reviews.forEach((r, ri) => {
      // spread review timestamps over the past ~10 days
      const ts = now - (pi * 4 + ri) * 6 * 60 * 60 * 1000;
      items.push({
        productId: p.id,
        sk: `REVIEW#${String(ri + 1).padStart(3, '0')}`,
        rating: r.rating,
        author: r.author,
        text: r.text,
        createdAt: new Date(ts).toISOString(),
      });
    });
  });
  return items;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const table = await resolveTableName();
  const items = buildItems();
  const productCount = items.filter((i) => i.sk === 'PRODUCT').length;
  const reviewCount = items.length - productCount;

  console.log(`Seeding ${productCount} products + ${reviewCount} reviews into ${table} ...`);

  for (const batch of chunk(items, 25)) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [table]: batch.map((Item) => ({ PutRequest: { Item } })) },
      }),
    );
  }

  console.log(`Done. ${items.length} items written.`);
}

main().catch((err) => {
  console.error('seed failed:', err);
  process.exit(1);
});
