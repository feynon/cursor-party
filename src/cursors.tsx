import * as React from "react";
import { render } from "react-dom";
import PresenceProvider from "./presence/presence-context";
import Cursors from "./presence/Cursors";

// Resolve the WebSocket host from the script URL so the same build works on
// workers.dev, custom domains and localhost without baking in a deployment URL.
const script = document.currentScript as HTMLScriptElement | null;
const cursorHost = new URL(script?.src || "/cursors.js", window.location.href).host;

const pageId = window?.location.href
  ? btoa(window.location.href.split(/[?#]/)[0])
  : "default";

function App() {
  return (
    <PresenceProvider
      host={cursorHost}
      room={pageId}
      presence={{
        name: "Anonymous User",
        color: "#0000f0",
      }}
    >
      <Cursors />
    </PresenceProvider>
  );
}

const cursorsRoot = document.createElement("div");
document.body.appendChild(cursorsRoot);
// cursors display is absolute and needs a top-level relative container
document.documentElement.style.position = "relative";
document.documentElement.style.minHeight = "100dvh";
// add a classname
cursorsRoot.classList.add("cursors-root");

render(<App />, cursorsRoot);
