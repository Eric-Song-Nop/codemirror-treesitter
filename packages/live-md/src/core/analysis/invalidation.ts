import { type ChangeDesc, type EditorState, type Transaction } from "@codemirror/state";
import { lineRangesForChanges, syntaxTreeChangedRanges } from "@codemirror-treesitter/language";
import { mapPreviousLiveMdSemanticUnits } from "./ids.js";
import { liveMdDirtyOwnerRanges } from "./owners.js";
import {
  activeLiveMdLineRanges,
  fullLiveMdDocRange,
  mergeLiveMdRanges,
  previousActiveLiveMdLineRanges,
} from "./ranges.js";
import type {
  LiveMdDocRange,
  LiveMdInvalidation,
  LiveMdInvalidationReason,
  LiveMdSemanticIndex,
  LiveMdSemanticUnit,
} from "./types.js";

export type CreateLiveMdInvalidationOptions = {
  activeLines: ReadonlySet<number>;
  configChanged?: boolean;
  previousActiveLines?: ReadonlySet<number>;
  previousIndex?: LiveMdSemanticIndex | null;
  selectionChanged?: boolean;
  startState?: EditorState | null;
  state: EditorState;
  transactions?: readonly Transaction[];
  treeChanged?: boolean;
  viewportChanged?: boolean;
  visibleRanges: readonly LiveMdDocRange[];
};

export function createLiveMdInvalidation(
  options: CreateLiveMdInvalidationOptions,
): LiveMdInvalidation {
  let reasons: LiveMdInvalidationReason[] = [];
  let dirtyRanges: LiveMdDocRange[] = [];
  let semanticDirtyRanges: LiveMdDocRange[] = [];
  let previousIndex = options.previousIndex ?? null;
  let transactions = options.transactions ?? [];

  if (!previousIndex) addLiveMdInvalidationReason(reasons, "init");
  if (transactions.some((transaction) => transaction.docChanged)) {
    addLiveMdInvalidationReason(reasons, "doc");
    let transactionDirtyRanges = liveMdTransactionDirtyRanges(transactions, options.state);
    dirtyRanges.push(...transactionDirtyRanges);
    semanticDirtyRanges.push(...transactionDirtyRanges);
  } else if (options.treeChanged) {
    addLiveMdInvalidationReason(reasons, "tree");
    let transactionDirtyRanges = liveMdTransactionDirtyRanges(transactions, options.state);
    dirtyRanges.push(...transactionDirtyRanges);
    semanticDirtyRanges.push(...transactionDirtyRanges);
  }

  if (options.selectionChanged) {
    addLiveMdInvalidationReason(reasons, "selection");
    dirtyRanges.push(
      ...liveMdSelectionDirtyRanges(
        options.startState ?? transactions[0]?.startState ?? options.state,
        options.state,
        liveMdTransactionsChangeDesc(transactions),
        options.previousActiveLines ?? previousIndex?.activeLines ?? new Set(),
        options.activeLines,
      ),
    );
  }

  if (options.viewportChanged) {
    addLiveMdInvalidationReason(reasons, "viewport");
    dirtyRanges.push(...options.visibleRanges);
    semanticDirtyRanges.push(...options.visibleRanges);
  }

  if (options.configChanged) {
    addLiveMdInvalidationReason(reasons, "config");
    dirtyRanges.push(...options.visibleRanges);
  }

  if (!dirtyRanges.length && !previousIndex) dirtyRanges.push(...fullLiveMdDocRange(options.state));
  if (!dirtyRanges.length && options.treeChanged) dirtyRanges.push(...options.visibleRanges);
  if (!semanticDirtyRanges.length && !previousIndex) {
    semanticDirtyRanges.push(...fullLiveMdDocRange(options.state));
  }
  if (!semanticDirtyRanges.length && options.treeChanged) {
    semanticDirtyRanges.push(...options.visibleRanges);
  }

  let mappedPreviousUnits = previousIndex
    ? mapLiveMdPreviousUnits(previousIndex.units, transactions)
    : [];
  let normalizedDirtyRanges = mergeLiveMdRanges(dirtyRanges);
  let normalizedSemanticDirtyRanges = mergeLiveMdRanges(semanticDirtyRanges);
  return {
    dirtyOwnerRanges: previousIndex
      ? liveMdDirtyOwnerRanges(previousIndex.ownerRanges, normalizedDirtyRanges)
      : normalizedDirtyRanges,
    dirtyRanges: normalizedDirtyRanges,
    mappedPreviousUnits,
    reasons,
    semanticDirtyRanges: normalizedSemanticDirtyRanges,
  };
}

export function emptyLiveMdInvalidation(): LiveMdInvalidation {
  return {
    dirtyOwnerRanges: [],
    dirtyRanges: [],
    mappedPreviousUnits: [],
    reasons: [],
    semanticDirtyRanges: [],
  };
}

function liveMdTransactionDirtyRanges(
  transactions: readonly Transaction[],
  fallbackState: EditorState,
) {
  let dirtyRanges: LiveMdDocRange[] = [];
  for (let transaction of transactions) {
    let treeRanges = syntaxTreeChangedRanges(transaction);
    if (transaction.docChanged) {
      dirtyRanges.push(...lineRangesForChanges(transaction.state, transaction.changes, []));
    } else {
      dirtyRanges.push(...treeRanges);
    }
  }
  return dirtyRanges.length ? dirtyRanges : fullLiveMdDocRange(fallbackState);
}

function liveMdSelectionDirtyRanges(
  startState: EditorState,
  state: EditorState,
  changes: ChangeDesc | null,
  previousActiveLines: ReadonlySet<number>,
  activeLines: ReadonlySet<number>,
) {
  return [
    ...previousActiveLiveMdLineRanges(startState, state, changes, previousActiveLines),
    ...activeLiveMdLineRanges(state, activeLines),
  ];
}

function liveMdTransactionsChangeDesc(transactions: readonly Transaction[]) {
  let changes: ChangeDesc | null = null;
  for (let transaction of transactions) {
    if (transaction.changes.empty) continue;
    changes = changes ? changes.composeDesc(transaction.changes) : transaction.changes;
  }
  return changes;
}

function mapLiveMdPreviousUnits(
  units: readonly LiveMdSemanticUnit[],
  transactions: readonly Transaction[],
) {
  let mapped = units;
  for (let transaction of transactions) {
    if (!transaction.docChanged) continue;
    mapped = mapPreviousLiveMdSemanticUnits(mapped, transaction.changes, transaction.state);
  }
  return mapped == units ? units : mapped;
}

function addLiveMdInvalidationReason(
  reasons: LiveMdInvalidationReason[],
  reason: LiveMdInvalidationReason,
) {
  if (!reasons.includes(reason)) reasons.push(reason);
}
