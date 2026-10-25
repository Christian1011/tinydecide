// Type definitions for tinydecide.

/** learning: every call goes to your API · local: confident calls answered locally · guarded: back to your API after a failed check. */
export type Mode = 'learning' | 'local' | 'guarded';

/** Call it exactly like your API function. */
export interface Decide<I, R> {
  (input: I): Promise<R>;
  /** The answer plus who gave it. */
  detailed(input: I): Promise<Detailed<R>>;
  /** Runs the local model synchronously; null before the first model. Ignores the cutoff check: see `local` in the result. */
  local(input: I): Decision | null;
  /** Compiles now instead of on the schedule. Resolves to the report, or null if the compile was discarded. */
  compile(): Promise<Report | null>;
  /** Resolves once a saved model and state are loaded. Calls made before then go to your API. */
  readonly ready: Promise<void>;
  /** Stops compiling and closes the store. */
  close(): Promise<void>;
  stats(): Stats;
  readonly mode: Mode;
  readonly model: Model | null;
}

export interface Detailed<R> {
  value: R;
  /** local: the model answered · api: your API answered · fallback: your API threw and `fallback` was on. */
  source: 'local' | 'api' | 'fallback';
  /** The label, or null when none could be read from your API's response. */
  choice: string | null;
  /** The local model's confidence; null when your API answered. */
  confidence: number | null;
  ms: number;
}

export interface ShadowOptions<I = any, R = any> {
  /** Agreement with your API to certify, overall across all calls. Default 0.98. */
  target?: number;
  /** One minus the confidence of the certificate. Default 0.05 (95% confidence). */
  delta?: number;
  /** Share of calls your API also answers in the background, to check agreement live. Default 0.02. */
  audit?: number;
  /** Fixes the label set and its order. Needed when your API returns label indexes or probability arrays. */
  labels?: string[];
  /** Starts from a compiled model, such as one built with `tinydecide compile`. */
  model?: Model;
  /** Where answers, the model and its state live. Default: memory; in Node, `.tinydecide/<name>/` for a named decision. */
  store?: Store;
  /** Node only: the folder that holds named decisions. Default `.tinydecide`, or `$TINYDECIDE_DIR`. */
  dir?: string;
  /** Keeps related calls (one conversation, one customer) in the same split, so the certificate covers new ones. */
  group?: (input: I) => string | number | null | undefined;
  /** Reads the label, and optionally probabilities, from your API's response. Default: a string, or `choice` / `label` / `decision` / `answer` with `probs`. */
  choice?: (response: R, labels: string[] | undefined) => { choice: string | null; probs?: Record<string, number> | null } | null | undefined;
  /** Builds a local answer. Default: the label under the same key your API uses, plus `probs` and `confidence` if your API returns them. */
  respond?: (decision: Decision, shape: ResponseShape | null) => R;
  /** Answers locally when your API throws and a model exists. Default false. */
  fallback?: boolean;
  /** One line per lifecycle event (never per call). true uses console.info; false is silent. Default true. */
  log?: boolean | ((line: string, event: ShadowEvent) => void);
  onEvent?: (event: ShadowEvent) => void;
  /** When to compile. `false` compiles only when you call `decide.compile()`. */
  autoCompile?: false | {
    /** Answers before the first compile. Default 2000. */
    min?: number;
    /** Recompile when answers grow by this factor. Default 2. */
    growth?: number;
    /** …but at least every this many answers. Default 20000. */
    maxEvery?: number;
    /** Most recent answers a compile uses. Default 50000. */
    window?: number;
  };
  /** Extra options for each compile. */
  compile?: Partial<CompileOptions>;
  /** Replaces the compile function. Node uses a worker thread by default. */
  compiler?: (rows: AnswerRecord[], options: CompileOptions & { background?: boolean }) => Promise<{ model: Model; report: Report }>;
  /** Source of randomness for the audit sample. Default Math.random. */
  random?: () => number;
}

/**
 * Wraps your decision API. Every call still goes to your API until a local model is certified; then
 * calls the model is sure about are answered in microseconds and the rest still go to your API.
 *
 * @param name names the decision in logs; in Node it is also the folder in `.tinydecide/` that keeps its answers and model.
 * @param api your existing call. Return a label string, or an object with `label` (or `choice`) and optional `probs`.
 */
export function shadow<I = string, R = string>(name: string, api: (input: I) => R | Promise<R>, options?: ShadowOptions<I, Awaited<R>>): Decide<I, Awaited<R>>;
export function shadow<I = string, R = string>(api: (input: I) => R | Promise<R>, options?: ShadowOptions<I, Awaited<R>>): Decide<I, Awaited<R>>;

export interface ResponseShape {
  kind: 'string' | 'object';
  key?: string;
  numeric?: boolean;
  probsKey?: string | null;
  probsArray?: boolean;
  confidence?: boolean;
}

export interface Stats {
  name: string | null;
  mode: Mode;
  calls: number;
  local: number;
  api: number;
  fallback: number;
  audits: number;
  auditDisagree: number;
  compiles: number;
  errors: number;
  /** Answers in the store. */
  logged: number;
  /** Share of calls answered locally since start. */
  share: number;
  apiCallsSaved: number;
  /** Agreement on the audit sample since the last install. */
  live: { sampled: number; agreement: number | null; ci: [number, number] | null };
  /** Agreement of the model's guess on calls your API answered, against what calibration measured. */
  deferred: { checked: number; agreement: number | null; baseline: number | null };
  model: { labels: number; cutoff: number; expectedShare: number | null; created: string | null } | null;
}

export type ShadowEvent =
  | { type: 'start'; t: number; mode: Mode; min?: number; logged?: number; share?: number; target?: number; since?: number }
  | { type: 'compile:start'; t: number; rows: number }
  | { type: 'compile'; t: number; report: Report; recovering: boolean }
  | { type: 'install'; t: number; share: number; verdict: Verdict; model: Model; report: Report }
  | { type: 'discard'; t: number; reason: string }
  | { type: 'guard'; t: number; reason: 'drift' | 'schema'; slice?: 'audit' | 'deferred'; agreement?: number; baseline?: number; sampled?: number; upper?: number; target?: number; label?: string }
  | { type: 'audit'; t: number; agree: boolean; local: string; api: string }
  | { type: 'unreadable'; t: number; preview: string }
  | { type: 'error'; t: number; where: string; error: string };

/** One logged answer from your API. */
export interface AnswerRecord {
  t: number;
  input: unknown;
  choice: string;
  probs?: Record<string, number>;
  group?: string;
  /** false when the call was logged only because the model deferred it: used for training, never for certifying. */
  sample?: false;
}

/** Where shadow() keeps answers, the model and its state. Only append, load and size are required. */
export interface Store {
  append(record: AnswerRecord): void;
  /** The most recent answers, oldest first. */
  load(): AnswerRecord[] | Promise<AnswerRecord[]>;
  readonly size?: number;
  loadModel?(): Model | null | Promise<Model | null>;
  saveModel?(model: Model, report: Report): void | Promise<void>;
  loadState?(): StoreState | null | Promise<StoreState | null>;
  saveState?(state: StoreState | null): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface StoreState { guardedSince: number }

/** Keeps answers and the model in memory. The default outside Node. */
export function memoryStore(options?: { limit?: number; records?: AnswerRecord[] }): Store & { readonly records: AnswerRecord[] };

export type Verdict = 'ship' | 'marginal' | 'not-worth-it' | 'need-more-data';

export interface CompileOptions {
  /** Default 0.98. */
  target: number;
  /** Default 0.05. */
  delta: number;
  /** overall: agreement across all calls, where your API's own answers count as agreeing (default). local: agreement on local answers alone. */
  guarantee: 'overall' | 'local';
  labels?: string[];
  /** Share of rows held out to certify the cutoff. Default 0.25. */
  calib: number;
  /** Share of rows held out to report on. Default 0.1. */
  test: number;
  seed: number;
  /** The audit rate the model will run with, used to estimate savings. Default 0.02. */
  audit: number;
  onProgress?: (progress: { phase: string; done: number }) => void;
  signal?: AbortSignal;
}

/**
 * One line of traffic: `input` (or `text`), the label as `choice` / `label` / `decision` / `answer`
 * (or an index into `labels`), and optionally `probs` and `group`.
 */
export type TrafficRecord = Record<string, unknown>;

export function compile(records: Iterable<TrafficRecord>, options?: Partial<CompileOptions>): Promise<{ model: Model; report: Report }>;

export interface Report {
  verdict: Verdict;
  /** One plain-English sentence. */
  summary: string;
  labels: string[];
  target: number;
  delta: number;
  guarantee: 'overall' | 'local';
  rows: { total: number; train: number; calib: number; test: number; skipped: number };
  features: number;
  epochs: number;
  certificate: Certificate;
  calib: { share: number; localAgreement: number | null; overallAgreement: number | null; rawAgreement: number | null };
  /** What the cutoff did on held-out rows, with 95% Wilson intervals. */
  test: {
    n: number;
    share: number;
    overallAgreement: number;
    overallCI: [number, number];
    localAgreement: number | null;
    localCI: [number, number] | null;
    rawAgreement: number;
    int8Flips: number;
  } | null;
  /** Share answered locally at other targets. */
  whatIf: { target: number; share: number }[];
  savings: { apiCallsAvoided: number; auditRate: number };
  temperature: number;
  bytes: number;
  latencyUs: number;
  ms: { train: number; total: number };
}

export interface Certificate {
  target: number;
  delta: number;
  guarantee: 'overall' | 'local';
  /** Calibration rows. */
  n: number;
  local: number;
  errors: number;
  pValue: number;
  /** Answer locally when the top-two logit margin is at least this. Infinity when nothing certified. */
  cutoff: number;
}

export interface Decision {
  choice: string;
  index: number;
  confidence: number;
  /** Gap between the top two logits. */
  margin: number;
  /** Whether the margin clears the certified cutoff. */
  local: boolean;
  probs?: Record<string, number>;
}

export interface ModelMeta {
  created?: string;
  certificate?: Certificate;
  rows?: { total: number; train: number; calib: number; test: number };
  expected?: { share: number; localAgreement: number | null; deferred: { n: number; agreement: number | null } };
  verdict?: Verdict;
  response?: ResponseShape | null;
  [key: string]: unknown;
}

export class Model {
  readonly labels: string[];
  readonly cutoff: number;
  /** Temperature for the reported confidence. */
  readonly T: number;
  readonly meta: ModelMeta;
  /** Size of the weights in bytes. */
  readonly bytes: number;
  decide(input: unknown, options?: { probs?: boolean }): Decision;
  /** Raw logits. The array is reused by the next call. */
  logits(input: unknown): Float32Array;
  /** A copy with a different cutoff. */
  withCutoff(cutoff: number): Model;
  /** The .tdm file format. */
  toBytes(): Uint8Array;
  static fromBytes(bytes: Uint8Array | ArrayBuffer): Model;
}

// ── Node only ───────────────────────────────────────────────────────────────────────────────────

/** Node only. Keeps one decision in a folder: answers.jsonl, model.tdm, report.json and, while guarded, state.json. */
export function fileStore(dir: string, options?: { limit?: number }): Store & { readonly dir: string };
/** Node only. */
export function loadModel(path: string): Model;
/** Node only. Writes atomically. */
export function saveModel(path: string, model: Model): void;
/** Node only. Reads .jsonl or .jsonl.gz, skipping lines that are not valid JSON. */
export function readJsonl(path: string, options?: { onSkip?: (line: number) => void }): Record<string, unknown>[];
