import { Server, routePartykitRequest } from "partyserver";
import type { Connection, ConnectionContext } from "partyserver";
import type { Metadata, Presence, User, PartyMessage } from "./presence/presence-schema";
import { clientMessageSchema, decodeMessage, encodePartyMessage } from "./presence/presence-schema";

export type Env = {
  Main: DurableObjectNamespace<PresenceServer>;
  ASSETS: Fetcher;
  WEBSITES: string;
};

function checkWebsite(request: Request, env: Env): Response | undefined {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  if (!from) return new Response("Not Allowed", { status: 403 });

  let page: URL;
  try {
    page = new URL(from);
  } catch {
    return new Response("Invalid page URL", { status: 400 });
  }

  const origin = request.headers.get("Origin");
  if (origin && origin !== page.origin) {
    return new Response("Not Allowed", { status: 403 });
  }

  const local = ["localhost", "127.0.0.1", "0.0.0.0"];
  if (local.includes(url.hostname) && local.includes(page.hostname)) return;
  // The Worker's own page is a two-window cursor demo.
  if (page.origin === url.origin) return;

  const websites: string[] = JSON.parse(env.WEBSITES);
  if (!websites.some((pattern) => new URLPattern(pattern).test(page.origin + page.pathname))) {
    return new Response("Not Allowed", { status: 403 });
  }
}
type ConnectionState = {
  metadata?: Metadata;
  presence?: Presence;
};
export type ConnectionWithUser = Connection<ConnectionState>;

const BROADCAST_INTERVAL = 1000 / 60; // 60fps

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET",
  "Access-Control-Allow-Headers":
    "Origin, X-Requested-With, Content-Type, Accept",
};

// server.ts
export class PresenceServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // pending updates are stored in memory and sent every tick
  add: { [id: string]: User } = {};
  presence: { [id: string]: Presence } = {};
  remove: string[] = [];

  lastBroadcast = 0;
  interval: ReturnType<typeof setInterval> | null = null;

  onConnect(
    connection: ConnectionWithUser,
    { request }: ConnectionContext
  ): void | Promise<void> {
    const metadata = { country: request.cf?.country ?? null } as Metadata;

    // The client may set name and color (from the presence object) in the query string
    const params = new URLSearchParams(request.url.split("?")[1]);
    const presence = {
      name: params.get("name") ?? "Anonymous User",
      color: params.get("color") ?? "#0000f0",
    } as Presence;

    // Stash the metadata and the presence on the websocket
    connection.setState((prevState) => ({
      presence: { ...prevState?.presence, ...presence },
      metadata,
    }));

    this.join(connection);

    //console.log("onConnect", this.name, connection.id, request.cf?.country);
  }

  enqueueAdd(id: string, user: User) {
    this.add[id] = user;
  }

  enqueuePresence(id: string, presence: Presence) {
    this.presence[id] = presence;
  }

  enqueueRemove(id: string) {
    this.remove.push(id);
    delete this.presence[id];
  }

  getUser(connection: ConnectionWithUser): User {
    return {
      presence: connection.state?.presence ?? ({} as Presence),
      metadata: connection.state?.metadata ?? ({} as Metadata),
    };
  }

  makeSyncMessage() {
    // Build users list
    const users = <Record<string, User>>{};
    for (const connection of this.getConnections<ConnectionState>()) {
      const user = this.getUser(connection);
      users[connection.id] = user;
    }

    return {
      type: "sync",
      users,
    } satisfies PartyMessage;
  }

  join(connection: ConnectionWithUser) {
    // Keep the presence on the websocket. onConnect will add metadata
    connection.setState((prevState) => ({
      ...prevState,
      presence: connection.state?.presence ?? ({} as Presence),
    }));
    this.enqueueAdd(connection.id, this.getUser(connection));
    // Reply with the current presence of all connections, including self
    const sync = this.makeSyncMessage();
    //connection.send(JSON.stringify(sync));
    //console.log("sync", JSON.stringify(sync, null, 2));
    connection.send(encodePartyMessage(sync));
  }

  leave(connection: ConnectionWithUser) {
    this.enqueueRemove(connection.id);
    this.broadcastChanges().catch((err) => {
      console.error(err);
    });
  }

  onMessage(
    connection: ConnectionWithUser,
    msg: string | ArrayBuffer
  ): void | Promise<void> {
    //const message = JSON.parse(msg as string) as ClientMessage;
    let decoded: unknown;
    try {
      decoded = decodeMessage(msg);
    } catch {
      return;
    }
    const result = clientMessageSchema.safeParse(decoded);
    if (!result.success) return;
    const message = result.data;
    /*console.log(
      "onMessage",
      this.name,
      connection.id,
      JSON.stringify(message, null, 2)
    );*/
    switch (message.type) {
      case "update": {
        // A presence update, replacing the existing presence
        connection.setState((prevState) => {
          this.enqueuePresence(connection.id, message.presence);
          return {
            ...prevState,
            presence: message.presence,
          };
        });
        break;
      }
    }

    this.broadcastChanges().catch((err) => {
      console.error(err);
    });
  }

  onClose(connection: ConnectionWithUser) {
    this.leave(connection);
  }

  onError(connection: ConnectionWithUser) {
    this.leave(connection);
  }

  async broadcastChanges() {
    // Broadcasts deltas. Looks at lastBroadcast
    // - If it's longer ago than BROADCAST_INTERVAL, broadcasts immediately
    // - If it's less than BROADCAST_INTERVAL ago, schedules an alarm
    //   to broadcast later
    const now = Date.now();
    const ago = now - this.lastBroadcast;
    if (ago >= BROADCAST_INTERVAL) {
      this._broadcast();
    } else {
      if (!this.interval) {
        this.interval = setInterval(() => {
          this._broadcast();
          if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
          }
        }, BROADCAST_INTERVAL - ago);
      }
    }
  }

  _broadcast() {
    this.lastBroadcast = Date.now();

    // Avoid the situation where there's only one connection and we're
    // rebroadcasting its own deltas to it
    const connections = [...this.getConnections<ConnectionState>()];
    const presenceUniqueIds = new Set(Object.keys(this.presence));
    if (
      connections.length === 1 &&
      this.remove.length === 0 &&
      Object.keys(this.add).length === 0 &&
      presenceUniqueIds.size === 1 &&
      presenceUniqueIds.has(connections[0].id)
    ) {
      this.presence = {};
      return;
    }

    const update = {
      type: "changes",
      add: this.add,
      presence: this.presence,
      remove: this.remove,
    } satisfies PartyMessage;
    //this.broadcast(JSON.stringify(update));
    this.broadcast(encodePartyMessage(update));
    this.add = {};
    this.presence = {};
    this.remove = [];
  }

  async onRequest(req: Request) {
    if (req.method === "GET") {
      // For SSR, return the current presence of all connections
      const users = [...this.getConnections<ConnectionState>()].reduce(
        (acc, user) => ({ ...acc, [user.id]: this.getUser(user) }),
        {}
      );
      return Response.json({ users }, { status: 200, headers: CORS });
    }

    // respond to cors preflight requests
    if (req.method === "OPTIONS") {
      return Response.json({ ok: true }, { status: 200, headers: CORS });
    }

    return new Response("Method Not Allowed", { status: 405 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "cursor-party" });
    }

    // Compatibility for scripts cached before the PartyServer cutover.
    if (url.pathname.startsWith("/party/")) {
      url.pathname = url.pathname.replace("/party/", "/parties/main/");
      request = new Request(url, request);
    }

    if (url.pathname.startsWith("/parties/")) {
      return (
        (await routePartykitRequest(request, env, {
          onBeforeConnect: (req) => checkWebsite(req, env),
        })) || new Response("Not Found", { status: 404 })
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
