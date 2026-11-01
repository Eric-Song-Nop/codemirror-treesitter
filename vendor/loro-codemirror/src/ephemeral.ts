import {
    layer,
    RectangleMarker,
    type EditorView,
    type PluginValue,
    type ViewUpdate,
} from "@codemirror/view";
import {
    Cursor,
    EphemeralStore,
    LoroDoc,
    LoroText,
    type Subscription,
} from "loro-crdt";
import {
    getCursorState,
    type UserState,
    type CursorState,
    RemoteCursorMarker,
} from "./awareness.ts";
import {
    EditorSelection,
    StateEffect,
    StateField,
    type Extension,
} from "@codemirror/state";

export const ephemeralEffect = StateEffect.define<EphemeralEffect>();
export const ephemeralStateField = StateField.define<{
    remoteCursors: Map<string, { anchor: number; head?: number }>;
    remoteUsers: Map<string, UserState | undefined>;
    isCheckout: boolean;
}>({
    create() {
        return {
            remoteCursors: new Map(),
            remoteUsers: new Map(),
            isCheckout: false,
        };
    },
    update(value, tr) {
        // Preserve old EditorState snapshots and keep numeric positions valid even
        // before the deferred CRDT refresh can run.
        value = { ...value, remoteCursors: new Map(value.remoteCursors), remoteUsers: new Map(value.remoteUsers) };
        if (tr.docChanged) {
            for (const [peer, cursor] of value.remoteCursors) {
                value.remoteCursors.set(peer, {
                    anchor: tr.changes.mapPos(cursor.anchor),
                    head: cursor.head === undefined ? undefined : tr.changes.mapPos(cursor.head),
                });
            }
        }
        for (const effect of tr.effects) {
            if (effect.is(ephemeralEffect)) {
                switch (effect.value.type) {
                    case "delete":
                        value.remoteCursors.delete(effect.value.peer);
                        break;
                    case "cursor":
                        const { peer, cursor } = effect.value;
                        value.remoteCursors.set(peer, {
                            anchor: Math.max(0, Math.min(tr.newDoc.length, cursor.anchor)),
                            head: cursor.head === undefined ? undefined : Math.max(0, Math.min(tr.newDoc.length, cursor.head)),
                        });
                        break;
                    case "user":
                        const { peer: uid, user } = effect.value;
                        if (user === undefined) value.remoteUsers.delete(uid);
                        else value.remoteUsers.set(uid, user);
                        break;
                    case "checkout":
                        value.isCheckout = effect.value.checkout;
                }
            }
        }
        return value;
    },
});

type EphemeralEffect =
    | {
          type: "delete";
          peer: string;
      }
    | {
          type: "cursor";
          peer: string;
          cursor: { anchor: number; head?: number };
      }
    | {
          type: "user";
          peer: string;
          user?: UserState;
      }
    | {
          type: "checkout";
          checkout: boolean;
      };

const getCursorEffect = (
    doc: LoroDoc,
    peer: string,
    state: CursorState
): StateEffect<EphemeralEffect> | undefined => {
    const cursors: Cursor[] = [];
    try {
        const resolve = (bytes: Uint8Array) => {
            const cursor = Cursor.decode(bytes);
            cursors.push(cursor);
            const position = doc.getCursorPos(cursor);
            if (position?.update) cursors.push(position.update);
            return position?.offset;
        };
        const anchorPos = resolve(state.anchor);
        const headPos = state.head ? resolve(state.head) : anchorPos;
        if (anchorPos === undefined || headPos === undefined) return;
        return ephemeralEffect.of({ type: "cursor", peer, cursor: { anchor: anchorPos, head: headPos } });
    } catch {
        // Presence can arrive before its referenced document operations.
        return;
    } finally {
        for (const cursor of cursors) cursor.free();
    }
};

export type EphemeralState = {
    [key: `${string}-cm-cursor`]: CursorState;
    [key: `${string}-cm-user`]: UserState | undefined;
};

const isRemoteCursorUpdate = (update: ViewUpdate): boolean => {
    const effect = update.transactions
        .flatMap((transaction) => transaction.effects)
        .filter((effect) => effect.is(ephemeralEffect));
    return update.docChanged || update.viewportChanged || effect.length > 0;
};

export const createCursorLayer = (): Extension => {
    return layer({
        above: true,
        class: "loro-cursor-layer",
        update: isRemoteCursorUpdate,
        markers: (view) => {
            const { remoteCursors, remoteUsers, isCheckout } =
                view.state.field(ephemeralStateField);
            if (isCheckout) {
                return [];
            }
            return Array.from(remoteCursors.entries()).flatMap(
                ([peer, state]) => {
                    const selectionRange = EditorSelection.cursor(state.anchor);
                    const user = remoteUsers.get(peer);
                    return RemoteCursorMarker.createCursor(
                        view,
                        selectionRange,
                        user?.name || "unknown",
                        user?.colorClassName || ""
                    );
                }
            );
        },
    });
};

export const createSelectionLayer = (): Extension =>
    layer({
        above: false,
        class: "loro-selection-layer",
        update: isRemoteCursorUpdate,
        markers: (view) => {
            const { remoteCursors, remoteUsers, isCheckout } =
                view.state.field(ephemeralStateField);
            if (isCheckout) {
                return [];
            }
            return Array.from(remoteCursors.entries())
                .filter(
                    ([_, state]) =>
                        state.head !== undefined && state.anchor !== state.head
                )
                .flatMap(([peer, state]) => {
                    const user = remoteUsers.get(peer);
                    const selectionRange = EditorSelection.range(
                        state.anchor,
                        state.head!
                    );
                    const markers = RectangleMarker.forRange(
                        view,
                        `loro-selection ${user?.colorClassName || ""}`,
                        selectionRange
                    );
                    return markers;
                });
        },
    });

export class EphemeralPlugin implements PluginValue {
    sub: Subscription;
    ephemeralSub: Subscription;
    initUser: boolean = false;
    private timer?: ReturnType<typeof setTimeout>;
    private destroyed = false;

    constructor(
        public view: EditorView,
        public doc: LoroDoc,
        public user: UserState,
        public ephemeralStore: EphemeralStore<EphemeralState>,
        private getTextFromDoc: (doc: LoroDoc) => LoroText
    ) {
        this.sub = this.doc.subscribe(() => this.scheduleRefresh());
        this.ephemeralSub = this.ephemeralStore.subscribe(() => this.scheduleRefresh());
        this.scheduleRefresh();
    }

    private scheduleRefresh(): void {
        if (this.destroyed || this.timer !== undefined) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.destroyed) return;
            const effects: StateEffect<EphemeralEffect>[] = [
                ephemeralEffect.of({ type: "checkout", checkout: this.doc.isDetached() }),
            ];
            const peers = new Set(this.view.state.field(ephemeralStateField).remoteCursors.keys());
            for (const key of this.ephemeralStore.keys()) {
                if (key.endsWith(CURSOR_KEY) || key.endsWith(USER_KEY)) peers.add(key.split("-")[0]);
            }
            for (const peer of peers) {
                if (peer === this.doc.peerIdStr) continue;
                const state = this.ephemeralStore.get(`${peer}-cm-cursor`);
                const cursor = state && getCursorEffect(this.doc, peer, state);
                effects.push(cursor ?? ephemeralEffect.of({ type: "delete", peer }));
                effects.push(ephemeralEffect.of({ type: "user", peer, user: this.ephemeralStore.get(`${peer}-cm-user`) }));
            }
            this.view.dispatch({ effects });
        }, 0);
    }

    update(update: ViewUpdate): void {
        if (
            !update.selectionSet &&
            !update.focusChanged &&
            !update.docChanged
        ) {
            return;
        }
        const selection = update.state.selection.main;
        if (this.view.hasFocus && !this.doc.isDetached()) {
            const cursorState = getCursorState(
                this.doc,
                selection.anchor,
                selection.head,
                this.getTextFromDoc
            );
            this.ephemeralStore.set(
                getCursorEphemeralKey(this.doc),
                cursorState
            );
            if (!this.initUser) {
                this.ephemeralStore.set(
                    getUserEphemeralKey(this.doc),
                    this.user
                );
                this.initUser = true;
            }
        } else {
            // when checkout or blur
            this.ephemeralStore.delete(getCursorEphemeralKey(this.doc));
        }
    }

    destroy(): void {
        this.destroyed = true;
        clearTimeout(this.timer);
        this.sub?.();
        this.ephemeralSub?.();
        this.ephemeralStore.delete(getCursorEphemeralKey(this.doc));
        this.ephemeralStore.delete(getUserEphemeralKey(this.doc));
    }
}

const USER_KEY = "-cm-user";
const CURSOR_KEY = "-cm-cursor";
export const getUserEphemeralKey = (doc: LoroDoc) => {
    return `${doc.peerIdStr}${USER_KEY}` as const;
};
export const getCursorEphemeralKey = (doc: LoroDoc) => {
    return `${doc.peerIdStr}${CURSOR_KEY}` as const;
};
