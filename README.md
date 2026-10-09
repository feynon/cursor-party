# Cursor Party for ankeshbharti.com

Multiplayer cursors and ephemeral cursor chat, running on PartyServer and Cloudflare Workers in your own account. The frontend is embedded by `feynon/maze`.

Based on [PartyKit Cursor Party](https://github.com/partykit/cursor-party), under the included MIT license.

## Develop and verify

Use Node.js 22 or newer.

```sh
npm ci
npm run dev
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

`npm test` starts an isolated local Worker and checks binary cursor/chat updates between clients, room isolation, disconnects, website restrictions, legacy routes, and static assets.

## Deploy to Cloudflare

```sh
npx wrangler login --device
npx wrangler whoami
npm run deploy
```

If you have more than one account, select the intended account with `CLOUDFLARE_ACCOUNT_ID`. The Worker is named `cursor-party`. If that name is already used by a different application in the selected account, choose another Worker name before deploying.

The configuration creates a SQLite-backed `PresenceServer` Durable Object, supported on the Workers free plan. Deployments use Wrangler directly and do not depend on PartyKit's hosted deployment API.

The `WEBSITES` variable in `wrangler.jsonc` allows `ankeshbharti.com` and `www.ankeshbharti.com`. The Worker's own demo page is also allowed. Localhost is allowed only when running the local Worker. Update this allowlist if embedding the client on another site.

## Cut over the website

1. Deploy the Worker and retain the returned HTTPS URL.
2. Check `/health` and `/cursors.js`, then run `CURSOR_TEST_URL=https://<worker>.<account-subdomain>.workers.dev npm test`.
3. Replace the PartyKit script URL in `feynon/maze/pages/_app.js` with the deployed Worker's `/cursors.js` URL, keeping `strategy="lazyOnload"`.
4. After the website deploys, open the same page in two windows and check cursor movement and `/` chat.

The client determines its WebSocket host from its own script URL, so it does not need a build-time hostname. The server supports `/parties/main/:room` and the legacy `/party/:room` route. Page URLs continue to determine room IDs.

## State and rollback

The original server stores no durable room data. Cursor positions, names, colors, and chat text are temporary WebSocket presence state; there is no persisted history to export. Existing sessions reconnect to the new service when their pages reload.

Keep the old PartyKit deployment until the live check passes. During PartyKit's remaining service window, rollback is a revert of the script URL in `maze`. Do not delete the original deployment as part of the cutover.

[Official PartyServer migration guide](https://docs.partykit.io/guides/migrate-to-partyserver/)
