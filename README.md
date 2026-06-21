# shipsilently-js

Official JavaScript / TypeScript SDK for [ShipSilently](https://shipsilently.com) —
Cloudflare-native feature flags.

> **This repository is an automated, read-only mirror.** Source lives in the
> ShipSilently monorepo and is synced here on every change. Please do not open
> pull requests against this repo — they will be overwritten on the next sync.
> For issues or contributions, contact `hello@shipsilently.com`.

Ships first-class TypeScript types and works with both ESM (`import`) and
CommonJS (`require`) — no configuration required.

## Install

```bash
npm install shipsilently-js
# or
bun add shipsilently-js
```

## Usage

```ts
// ESM / TypeScript
import { ShipSilentlyClient } from 'shipsilently-js';
```

```js
// CommonJS
const { ShipSilentlyClient } = require('shipsilently-js');
```

```ts
import { ShipSilentlyClient } from 'shipsilently-js';

const client = new ShipSilentlyClient({
  apiKey: process.env.SHIPSILENTLY_API_KEY!,
});

// Evaluate a single flag with a default fallback.
const checkoutV2 = await client.evaluate('checkout-v2', { userId: 'user_123' }, false);

if (checkoutV2) {
  // ...new checkout flow
}

// Evaluate every flag for a user context at once.
const all = await client.evaluateAll({ userId: 'user_123', plan: 'pro' });
```

See the [ShipSilently docs](https://shipsilently.com) for the full API.

## License

[MIT](./LICENSE) © ShipSilently
