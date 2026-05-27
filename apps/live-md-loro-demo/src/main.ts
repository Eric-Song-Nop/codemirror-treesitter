import "./style.css";
import { EditorView } from "@codemirror/view";
import { defineLiveMdEditor, type LiveMdEditorElement } from "@codemirror-treesitter/live-md";
import {
  liveMdLoroCollaboration,
  liveMdLoroRedo,
  liveMdLoroUndo,
} from "@codemirror-treesitter/live-md-loro";
import { EphemeralStore, LoroDoc, UndoManager, type Value } from "loro-crdt";

type PeerId = "ada" | "linus";
type PacketKind = "doc" | "presence";
type DemoUser = {
  colorClassName: string;
  name: string;
  [key: string]: Value;
};

type Peer = {
  doc: LoroDoc;
  editor: LiveMdEditorElement | null;
  ephemeral: EphemeralStore;
  id: PeerId;
  label: string;
  localDocUpdates: number;
  localPresenceUpdates: number;
  receivedDocUpdates: number;
  receivedPresenceUpdates: number;
  undoManager: UndoManager;
  user: DemoUser;
};

type Packet = {
  bytes: Uint8Array;
  createdAt: number;
  from: PeerId;
  id: number;
  kind: PacketKind;
  size: number;
  to: PeerId;
};

const TEXT_KEY = "markdown";
const SAMPLE_MARKDOWN = `# Release notes draft

LiveMD is bound to a Loro text container named \`${TEXT_KEY}\`.

## Shared checklist

- [x] Local edits commit into Loro
- [x] Remote updates flow through a simulated network
- [ ] Disconnect, keep typing, then reconnect

> This page runs two peers locally so the transport can be slowed down or paused.`;

const USERS: Record<PeerId, DemoUser> = {
  ada: { colorClassName: "user-ada", name: "Ada" },
  linus: { colorClassName: "user-linus", name: "Linus" },
};

const collabTheme = EditorView.baseTheme({
  ".loro-cursor.user-ada": { backgroundColor: "#b7532f" },
  ".loro-cursor.user-ada::before": { background: "#b7532f", color: "#fffaf2" },
  ".loro-selection.user-ada": { backgroundColor: "rgba(183, 83, 47, 0.24)" },
  ".loro-cursor.user-linus": { backgroundColor: "#2f7972" },
  ".loro-cursor.user-linus::before": { background: "#2f7972", color: "#f1fbf9" },
  ".loro-selection.user-linus": { backgroundColor: "rgba(47, 121, 114, 0.24)" },
});

defineLiveMdEditor();

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main class="demo-shell">
    <header class="control-deck">
      <section class="identity">
        <p>LiveMD + Loro</p>
        <h1>Collaboration Lab</h1>
      </section>
      <section class="network-card" aria-label="Network status">
        <div class="network-map">
          <span class="node node-ada">Ada</span>
          <span id="packet-line" class="packet-line"></span>
          <span class="node node-linus">Linus</span>
        </div>
        <div class="metric-grid">
          <div>
            <span>State</span>
            <strong id="link-state">Online</strong>
          </div>
          <div>
            <span>Queued</span>
            <strong id="queued-count">0</strong>
          </div>
          <div>
            <span>In flight</span>
            <strong id="inflight-count">0</strong>
          </div>
          <div>
            <span>Delivered</span>
            <strong id="delivered-count">0</strong>
          </div>
        </div>
      </section>
      <section class="controls" aria-label="Transport controls">
        <label class="delay-control">
          <span>Delay</span>
          <input id="delay-input" type="range" min="0" max="2400" step="100" value="600" />
          <output id="delay-output">600 ms</output>
        </label>
        <div class="button-row">
          <button id="connection-toggle" type="button">Disconnect</button>
          <button id="flush-queue" type="button">Flush</button>
          <button id="drop-queue" type="button">Drop queue</button>
          <button id="resync-snapshot" type="button">Resync</button>
        </div>
        <div class="button-row">
          <button id="load-sample" type="button">Load sample</button>
          <button id="split-edit" type="button">Split edit</button>
          <button id="reset-room" type="button">Reset room</button>
        </div>
      </section>
    </header>
    <section class="workspace" aria-label="Collaborative editors">
      <article class="peer-card" data-peer="ada">
        <header>
          <div>
            <p>Peer A</p>
            <h2>Ada</h2>
          </div>
          <div class="peer-actions">
            <button id="ada-undo" type="button">Undo</button>
            <button id="ada-redo" type="button">Redo</button>
          </div>
        </header>
        <div id="ada-editor" class="editor-host"></div>
        <dl id="ada-stats" class="peer-stats"></dl>
      </article>
      <article class="peer-card" data-peer="linus">
        <header>
          <div>
            <p>Peer B</p>
            <h2>Linus</h2>
          </div>
          <div class="peer-actions">
            <button id="linus-undo" type="button">Undo</button>
            <button id="linus-redo" type="button">Redo</button>
          </div>
        </header>
        <div id="linus-editor" class="editor-host"></div>
        <dl id="linus-stats" class="peer-stats"></dl>
      </article>
      <aside class="queue-card">
        <header>
          <p>Transport</p>
          <h2>Pending packets</h2>
        </header>
        <ol id="queue-list" class="queue-list"></ol>
      </aside>
    </section>
  </main>
`;

function createPeers(): Record<PeerId, Peer> {
  let adaDoc = new LoroDoc();
  adaDoc.getText(TEXT_KEY).insert(0, SAMPLE_MARKDOWN);
  adaDoc.commit();

  let linusDoc = new LoroDoc();
  linusDoc.import(adaDoc.export({ mode: "snapshot" }));

  return {
    ada: createPeer("ada", "Ada", adaDoc),
    linus: createPeer("linus", "Linus", linusDoc),
  };
}

function createPeer(id: PeerId, label: string, doc: LoroDoc): Peer {
  return {
    doc,
    editor: null,
    ephemeral: new EphemeralStore(6000),
    id,
    label,
    localDocUpdates: 0,
    localPresenceUpdates: 0,
    receivedDocUpdates: 0,
    receivedPresenceUpdates: 0,
    undoManager: new UndoManager(doc, {}),
    user: USERS[id],
  };
}

function subscribePeer(peer: Peer, link: SimulatedTransport) {
  peer.doc.subscribeLocalUpdates((bytes) => {
    peer.localDocUpdates++;
    link.send("doc", peer.id, bytes);
  });
  peer.ephemeral.subscribeLocalUpdates((bytes) => {
    peer.localPresenceUpdates++;
    link.send("presence", peer.id, bytes);
  });
}

function mountPeer(peer: Peer) {
  let host = document.querySelector<HTMLDivElement>(`#${peer.id}-editor`)!;
  let editor = document.createElement("live-md-editor") as LiveMdEditorElement;
  editor.placeholder = `${peer.label} is editing...`;
  editor.extensions = [
    collabTheme,
    liveMdLoroCollaboration({
      doc: peer.doc,
      presence: { ephemeral: peer.ephemeral, user: peer.user },
      undoManager: peer.undoManager,
    }),
  ];
  if (peer.id == "ada") editor.setAttribute("autofocus", "");
  editor.addEventListener("input", render);
  host.append(editor);
  peer.editor = editor;
  editor.ready
    .then(() => {
      let cursor = peer.id == "ada" ? 0 : Math.min(36, editor.value.length);
      editor.setSelectionRange(cursor, cursor);
      render();
    })
    .catch((error: unknown) => console.error(error));
}

function connectControls() {
  let delayInput = document.querySelector<HTMLInputElement>("#delay-input")!;
  delayInput.addEventListener("input", () => {
    transport.delayMs = Number(delayInput.value);
    render();
  });
  document.querySelector<HTMLButtonElement>("#connection-toggle")!.addEventListener("click", () => {
    transport.setOnline(!transport.online);
  });
  document.querySelector<HTMLButtonElement>("#flush-queue")!.addEventListener("click", () => {
    transport.flush();
  });
  document.querySelector<HTMLButtonElement>("#drop-queue")!.addEventListener("click", () => {
    transport.dropQueue();
  });
  document.querySelector<HTMLButtonElement>("#resync-snapshot")!.addEventListener("click", () => {
    resyncFrom("ada");
  });
  document.querySelector<HTMLButtonElement>("#load-sample")!.addEventListener("click", () => {
    replaceEditorText(peers.ada, SAMPLE_MARKDOWN);
  });
  document.querySelector<HTMLButtonElement>("#split-edit")!.addEventListener("click", () => {
    runSplitEdit();
  });
  document.querySelector<HTMLButtonElement>("#reset-room")!.addEventListener("click", () => {
    globalThis.location.reload();
  });
  for (let id of ["ada", "linus"] as const) {
    document.querySelector<HTMLButtonElement>(`#${id}-undo`)!.addEventListener("click", () => {
      let view = peers[id].editor?.view;
      if (view) liveMdLoroUndo(view);
      render();
    });
    document.querySelector<HTMLButtonElement>(`#${id}-redo`)!.addEventListener("click", () => {
      let view = peers[id].editor?.view;
      if (view) liveMdLoroRedo(view);
      render();
    });
  }
}

function replaceEditorText(peer: Peer, value: string) {
  let view = peer.editor?.view;
  if (!view) return;
  view.dispatch({
    changes: { from: 0, insert: value, to: view.state.doc.length },
    selection: { anchor: 0 },
    userEvent: "input.demo.load",
  });
}

function runSplitEdit() {
  if (transport.online) transport.setOnline(false);
  appendEditorText(peers.ada, `\n\n_Ada offline edit ${timestamp()}._`);
  appendEditorText(peers.linus, `\n\n_Linus offline edit ${timestamp()}._`);
  render();
}

function appendEditorText(peer: Peer, value: string) {
  let view = peer.editor?.view;
  if (!view) return;
  view.dispatch({
    changes: { from: view.state.doc.length, insert: value },
    selection: { anchor: view.state.doc.length + value.length },
    userEvent: "input.demo.append",
  });
}

function resyncFrom(sourceId: PeerId) {
  let source = peers[sourceId];
  let target = peers[otherPeer(sourceId)];
  target.doc.import(source.doc.export({ mode: "snapshot" }));
  transport.clear();
  render();
}

function render() {
  document.documentElement.dataset.connection = transport.online ? "online" : "offline";
  document.querySelector("#link-state")!.textContent = transport.online ? "Online" : "Offline";
  document.querySelector("#queued-count")!.textContent = String(transport.queue.length);
  document.querySelector("#inflight-count")!.textContent = String(transport.inFlight);
  document.querySelector("#delivered-count")!.textContent = String(transport.delivered);
  document.querySelector("#delay-output")!.textContent = `${transport.delayMs} ms`;
  document.querySelector("#connection-toggle")!.textContent = transport.online
    ? "Disconnect"
    : "Reconnect";
  document.querySelector("#packet-line")!.classList.toggle("is-sending", transport.inFlight > 0);
  renderPeerStats(peers.ada);
  renderPeerStats(peers.linus);
  renderQueue();
}

function renderPeerStats(peer: Peer) {
  let stats = document.querySelector<HTMLDListElement>(`#${peer.id}-stats`)!;
  let text = peer.doc.getText(TEXT_KEY).toString();
  stats.replaceChildren(
    stat("Peer", shortPeerId(peer.doc.peerIdStr)),
    stat("Chars", String(text.length)),
    stat("Local", `${peer.localDocUpdates}/${peer.localPresenceUpdates}`),
    stat("Remote", `${peer.receivedDocUpdates}/${peer.receivedPresenceUpdates}`),
  );
}

function renderQueue() {
  let queueList = document.querySelector<HTMLOListElement>("#queue-list")!;
  if (!transport.queue.length) {
    let empty = document.createElement("li");
    empty.className = "empty-queue";
    empty.textContent = "No pending packets";
    queueList.replaceChildren(empty);
    return;
  }
  queueList.replaceChildren(
    ...transport.queue.slice(-8).map((packet) => {
      let item = document.createElement("li");
      item.innerHTML = `<span>${packet.kind}</span><strong>${packet.from} -> ${packet.to}</strong><em>${packet.size} B</em>`;
      return item;
    }),
  );
}

function stat(label: string, value: string) {
  let fragment = document.createDocumentFragment();
  let term = document.createElement("dt");
  let description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value;
  fragment.append(term, description);
  return fragment;
}

function timestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function shortPeerId(peerId: string) {
  return peerId.length > 8 ? `${peerId.slice(0, 4)}...${peerId.slice(-4)}` : peerId;
}

function otherPeer(peer: PeerId): PeerId {
  return peer == "ada" ? "linus" : "ada";
}

class SimulatedTransport {
  delayMs = 600;
  delivered = 0;
  inFlight = 0;
  online = true;
  queue: Packet[] = [];

  private nextId = 1;
  private peers: Record<PeerId, Peer>;
  private render: () => void;
  private timers = new Map<number, number>();

  constructor(peers: Record<PeerId, Peer>, render: () => void) {
    this.peers = peers;
    this.render = render;
  }

  send(kind: PacketKind, from: PeerId, bytes: Uint8Array) {
    let packet: Packet = {
      bytes: new Uint8Array(bytes),
      createdAt: performance.now(),
      from,
      id: this.nextId++,
      kind,
      size: bytes.byteLength,
      to: otherPeer(from),
    };
    if (!this.online) {
      this.queue.push(packet);
      this.render();
      return;
    }
    this.schedule(packet);
  }

  setOnline(online: boolean) {
    this.online = online;
    if (online) this.flush();
    this.render();
  }

  flush() {
    let packets = this.queue.splice(0);
    for (let packet of packets) this.schedule(packet);
    this.render();
  }

  dropQueue() {
    this.queue = [];
    this.render();
  }

  clear() {
    for (let timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.inFlight = 0;
    this.queue = [];
  }

  private schedule(packet: Packet) {
    this.inFlight++;
    let timer = window.setTimeout(() => {
      this.timers.delete(packet.id);
      this.inFlight--;
      this.deliver(packet);
      this.render();
    }, this.delayMs);
    this.timers.set(packet.id, timer);
    this.render();
  }

  private deliver(packet: Packet) {
    let target = this.peers[packet.to];
    if (packet.kind == "doc") {
      target.doc.import(packet.bytes);
      target.receivedDocUpdates++;
    } else {
      target.ephemeral.apply(packet.bytes);
      target.receivedPresenceUpdates++;
    }
    this.delivered++;
  }
}

const peers = createPeers();
const transport = new SimulatedTransport(peers, render);

subscribePeer(peers.ada, transport);
subscribePeer(peers.linus, transport);
mountPeer(peers.ada);
mountPeer(peers.linus);
connectControls();
render();
