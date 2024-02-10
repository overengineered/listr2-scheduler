import { Readable, Transform } from "node:stream";
import { EOL } from "node:os";
import * as color from "colorette";
import {
  delay,
  Listr,
  ListrLogger,
  ListrLogLevels,
  ListrTask,
  LoggerFieldOptions,
  ProcessOutput,
} from "listr2";

export interface Toolkit {}

/**
 * See https://github.com/overengineered/listr2-scheduler#executor-functions
 */
export type Worker<T = any> = {
  readonly data: T;
  readonly printer: "verbose" | "vivid";
  readonly updateTitle: (title: string) => void;
  readonly reportStatus: (text: string) => void;
  readonly publish: (text: string) => void;
  readonly getTag: (options?: { colored: boolean }) => string;
  readonly on: (event: "finalize", callback: ErrorCallback<void>) => void;
  readonly assertCanContinue: (tag?: string) => void;
  readonly toolkit: Toolkit;
};

export type Driver<Keys extends string> = {
  run: (
    options: {
      printer: "verbose" | "vivid";
      dryRun?: boolean;
      onError?: ShutdownMode | ErrorCallback<ShutdownMode>;
    } & (keyof Toolkit extends never
      ? { toolkit?: Toolkit }
      : { toolkit: Toolkit } | { attach: (worker: Worker) => Toolkit }),
    config?: Partial<Record<Keys, unknown>>
  ) => Promise<void>;
};

type ShutdownMode = "exit" | "finalize";
type ErrorCallback<T = void> = (error: unknown, executor: unknown) => T;

type Configurator<Keys extends string> = (
  when: Matcher<Keys>,
  make: (key: Keys) => Output<Keys>
) => void;

type Matcher<Keys extends string> = ((
  condition: Pattern<Keys> | Pattern<Keys>[] | null
) => Actions) &
  ((
    condition: Pattern<Keys> | Pattern<Keys>[] | null,
    output: Output<Keys>
  ) => Actions);

type Actions = {
  call: ((task: (worker: Worker) => Promise<unknown>) => void) &
    ((label: string, task: (worker: Worker) => Promise<unknown>) => void);
};

type Pattern<Keys extends string> = Keys | `?${Keys}` | `!${Keys}`;
type Output<Keys> = { key: Keys };

type Step = {
  id: string;
  title: string;
  isQualified: (config: Record<string, unknown>) => boolean;
  input: string[];
  output?: Output<string>;
  run: (worker: Worker) => unknown;
};

type Runtime = {
  done: Set<string>;
  waiting: Set<Step>;
  data: Record<string, unknown>;
  dryRun: boolean;
  onError: ShutdownMode | ErrorCallback<ShutdownMode>;
  logger?: ListrLogger;
  attach: (worker: Omit<Worker, "toolkit">) => Toolkit;
  failure?: { error: unknown };
  publish: (lines: string[]) => void;
  startWorking: (noticeError: ErrorCallback<void>) => void;
  endWorking: (noticeError: ErrorCallback<void>) => void;
  finalize: ErrorCallback<Promise<unknown>>;
};

const LS = /\r?\n/;

export function schedule<
  Source = string,
  Keys extends string = Source extends string ? Source : keyof Source & string
>(define: Configurator<Keys>): Driver<Keys> {
  const steps: Step[] = [];
  const when: Matcher<Keys> = (
    condition: Pattern<Keys> | Pattern<Keys>[] | null,
    output?: Output<Keys>
  ) => ({
    call: (
      nameSource: ((worker: Worker) => unknown) | string,
      fn?: (worker: Worker) => unknown
    ) => {
      const id = `@${String(steps.length + 1).padStart(2, "0")}`;
      const run = typeof nameSource === "function" ? nameSource : nonNull(fn);
      const title = typeof nameSource === "string" ? nameSource : getTitle(run);
      const input: string[] = [];
      const requirements: { key: string; expect: boolean }[] = [];
      asList(condition).forEach((pattern) => {
        if (pattern.startsWith("!") || pattern.startsWith("?")) {
          const key = pattern.slice(1);
          input.push(key);
          requirements.push({ key, expect: pattern.startsWith("?") });
        } else {
          input.push(pattern);
        }
      });
      const isQualified = (state: Record<string, unknown>) =>
        requirements.every(
          (condition) =>
            state[condition.key] === undefined ||
            !!state[condition.key] === condition.expect
        );
      steps.push({ id, title, isQualified, input, output, run });
    },
  });
  const make: (key: Keys) => Output<Keys> = (key) => ({ key });

  define(when, make);

  return {
    run: async (options, config) => {
      const runnable = steps.filter((it) => it.isQualified(config ?? {}));
      const inputs = new Set(runnable.flatMap((step) => step.input));
      const done = new Set(
        [...inputs].filter((key) => config && config[key as Keys] !== undefined)
      );
      const isReady = (step: Step) => step.input.every((key) => done.has(key));
      for (const key of inputs) {
        validate(runnable, key, [], done, isReady);
      }

      const logger = new CustomLogger(options.onError !== "exit");

      if (options.printer === "verbose" && runnable.length < steps.length) {
        for (const skipped of steps) {
          if (!runnable.includes(skipped)) {
            logger.log(ListrLogLevels.SKIPPED, `${skipped.title}`);
          }
        }
      }

      const remaining = new Set(runnable);

      const board: string[] = [];
      let shouldPrintBoard = false;
      let triggerExitSignal = (_?: unknown) => {};
      const exitSignal = new Promise((res) => (triggerExitSignal = res));
      const activeWorkers = new Set<ErrorCallback>();
      const checkWorkers = () => {
        // exitSignal can be sent before all work is complete:
        // Some task schedules the last task, but before it starts working another
        // task completes, triggering signal. It's OK when errors are encountered,
        // the scheduled task will not begin.
        if (activeWorkers.size + remaining.size === 0) {
          if (shouldPrintBoard) {
            board.forEach((line) => process.stdout.write(line + EOL));
          }
          triggerExitSignal();
        }
      };
      const startWorking = (callback: ErrorCallback) => {
        activeWorkers.add(callback);
      };
      const endWorking = (callback: ErrorCallback) => {
        activeWorkers.delete(callback);
        checkWorkers();
      };

      const ready = runnable.filter(isReady);
      ready.forEach((step) => remaining.delete(step));
      const runtime: Runtime = {
        data: { ...config },
        done,
        waiting: remaining,
        dryRun: !!options.dryRun,
        onError: options.onError ?? "finalize",
        logger: options.printer === "verbose" ? logger : undefined,
        attach: (options as any).attach ?? (() => options.toolkit ?? {}),
        publish: (lines) => board.push(...lines),
        startWorking,
        endWorking,
        finalize: (error: unknown, executor: unknown) => {
          if (!runtime.failure) {
            shouldPrintBoard = true;
            runtime.failure = { error };
            remaining.clear();
            activeWorkers.forEach((callback) => callback(error, executor));
            checkWorkers();
          }
          return exitSignal;
        },
      };
      const tasks = ready.map((step) => createTask(step, runtime));

      const start = Date.now();
      await new Listr(tasks, {
        concurrent: true,
        ...(options.printer === "vivid"
          ? {
              renderer: "default",
              collapseSkips: false,
              rendererOptions: {
                collapseSubtasks: false,
                formatOutput: "truncate",
              },
            }
          : {
              renderer: "verbose",
              rendererOptions: {
                logger,
              },
            }),
      }).run();

      board.forEach((line) => process.stdout.write(line + EOL));
      logger.log("FINISHED", formatDuration(Date.now() - start));
    },
  };
}

const ColorWheel = [
  color.bgYellow,
  color.bgBlue,
  color.bgMagenta,
  color.bgGreen,
  color.bgCyan,
  color.bgBlack,
];

function createTask(step: Step, runtime: Runtime): ListrTask {
  const { data, done, waiting, logger } = runtime;
  const stepTag = step.title + " " + color.yellow(step.id);
  return {
    title: stepTag,
    skip: () => !step.isQualified(data),
    task: async (_, executor) => {
      const num = Math.abs(parseInt(step.id.slice(1)));
      const bg = ColorWheel[isNaN(num) ? 0 : num % ColorWheel.length];
      const state = {
        start: Date.now(),
        title: step.title,
        isFinished: false,
        failure: undefined as { error: unknown } | undefined,
        log: [] as string[],
        publishLog: () => {
          if (state.log.length > 0) {
            state.log.unshift(`___ ${step.title.split(LS).join(" ")} ___`);
            runtime.publish(state.log);
          }
        },
        update: () => {
          const passed = formatDuration(Date.now() - state.start);
          executor.title =
            state.title + " " + (state.failure ? color.red : color.dim)(passed);
        },
        noticeError: (error: unknown, executor: unknown) => {
          try {
            state.registeredErrorListener(error, executor);
          } catch (cascading) {
            runtime.logger?.log(
              color.red("~FAIL~"),
              `${stepTag} Error on "finalize" ${getErrorDetails(cascading)}`
            );
          }
        },
        registeredErrorListener: (() => void 0) as ErrorCallback<void>,
      };
      undoTitleRewriteOnError(executor);
      const worker: Worker = withToolkit(runtime.attach, {
        data,
        printer: runtime.logger ? "verbose" : "vivid",
        getTag: (options) => (options?.colored ? bg(step.id) : step.id),
        updateTitle: (title) => !state.isFinished && (state.title = title),
        reportStatus: (status) => {
          if (state.isFinished) return;
          const lines = String(status).split(LS);
          if (runtime.logger) {
            lines.forEach(
              (line) => (executor.output = `${bg(step.id)} ${line}`)
            );
          } else {
            const message = lines.at(-1) ?? "";
            executor.output =
              message.length <= 80 ? message : "..." + message.slice(-77);
          }
        },
        publish: (message) => {
          if (state.isFinished) return;
          const text = String(message);
          if (runtime.logger) {
            runtime.logger?.log("PUBLISH", `${bg(step.id)}`);
            process.stdout.write(text.endsWith(EOL) ? text : text + EOL);
          } else {
            state.log.push(text);
          }
        },
        on: (event, callback) =>
          event === "finalize" && (state.registeredErrorListener = callback),
        assertCanContinue: (tag) => {
          if (runtime.failure) {
            if (!runtime.logger && tag) {
              executor.output = tag;
            }
            throw new Abort("CanContinue", false, tag);
          }
        },
      });
      const execute = runtime.dryRun
        ? () => Promise.resolve()
        : runtime.onError === "exit"
        ? () => step.run(worker)
        : async () => {
            if (runtime.failure) {
              state.failure = { error: runtime.failure.error };
              return;
            }
            try {
              runtime.startWorking(state.noticeError);
              await step.run(worker);
              runtime.endWorking(state.noticeError);
            } catch (error) {
              runtime.endWorking(state.noticeError);
              state.failure = { error };
            }
          };
      const result = await Promise.race([execute(), periodicUpdate(state)]);
      state.isFinished = true;
      state.title = step.title;
      if (state.failure) {
        const isUnexpected = !isAssertion(state.failure.error, "CanContinue");
        const details = isUnexpected
          ? getErrorDetails(state.failure.error)
          : String(state.failure.error);
        if (runtime.logger) {
          const level = isUnexpected ? color.red("~FAIL~") : "HALTED";
          runtime.logger.log(level, `${stepTag} ${details}`);
        } else {
          if (isUnexpected) {
            executor.output = String(state.failure.error);
          }
          state.update();
        }
        let shouldKillProcess = false;
        if (typeof runtime.onError === "function") {
          try {
            const instruction = runtime.onError(state.failure.error, step.run);
            shouldKillProcess = instruction === "exit";
          } catch (cascading) {
            const details = getErrorDetails(cascading);
            const message = `Failed to handle error (${details})`;
            runtime.logger?.log(color.red("~FAIL~"), `${stepTag} ${message}`);
          }
        }
        if (!shouldKillProcess) {
          await runtime.finalize(state.failure.error, step.run);
          if (
            !runtime.logger &&
            state.failure.error !== runtime.failure?.error
          ) {
            // Listr2 ends with nicer summary if we don't rush with exception
            await delay(500 + (num % 13) * 36);
          }
        }
        state.publishLog();
        throw runtime.failure?.error ?? state.failure?.error;
      }
      !logger && (executor.output = "");
      state.update();
      state.publishLog();
      if (step.output) {
        data[step.output.key] = result;
        done.add(step.output.key);
        const ready: Step[] = [];
        for (const step of waiting) {
          if (step.input.every((key) => done.has(key))) {
            waiting.delete(step);
            ready.push(step);
          }
        }
        if (ready.length > 0) {
          if (logger) {
            logger.log(ListrLogLevels.COMPLETED, executor.title);
          }
          return executor.newListr(
            ready.map((next) => createTask(next, runtime)),
            { concurrent: true }
          );
        }
      }
    },
  };
}

function validate(
  steps: Step[],
  key: string,
  visited: Step[],
  done: Set<string>,
  isRoot: (step: Step) => boolean
): void {
  const preceding = steps.filter((t) => t.output?.key === key);
  if (preceding.length === 0 && !done.has(key)) {
    const origin = steps.find((step) => step.input.includes(key));
    const info = origin ? ` required for ${origin.title}` : "";
    throw new Error(`Cannot find how to make "${key}"${info}`);
  }
  const remaining = preceding.filter((t) => !isRoot(t));
  for (const option of remaining) {
    if (visited.includes(option)) {
      const cycle = [...visited, option].map((it) => it.title).join("->");
      throw new Error(`Unsupported cycle found "${cycle}"`);
    }
    const optionPath = visited.concat(option);
    for (const target of option.input) {
      validate(steps, target, optionPath, done, isRoot);
    }
  }
}

function withToolkit(
  getToolkit: (worker: Omit<Worker, "toolkit">) => Toolkit,
  worker: Omit<Worker, "toolkit">
): Worker {
  return Object.assign(worker, { toolkit: getToolkit(worker) });
}

function periodicUpdate(state: { isFinished: boolean; update: () => void }) {
  let end = (value?: never): unknown => void value;
  const promise = new Promise<undefined>((res) => (end = res));
  const periodicTicker = setInterval(() => {
    if (state.isFinished) {
      end();
      clearInterval(periodicTicker);
    } else {
      state.update();
    }
  }, 125);
  return promise;
}

function getErrorDetails(error: unknown) {
  if (error && error instanceof Error) {
    return error.stack;
  } else {
    return String(error);
  }
}

function isAssertion(error: unknown, condition: string) {
  return (
    error &&
    typeof error === "object" &&
    AssertionTag in error &&
    error[AssertionTag] === condition
  );
}

const AssertionTag = Symbol("AssertionTag");

export class Abort extends Error {
  [AssertionTag]: string;
  constructor(condition: string, value: unknown, info?: string) {
    super(`${condition}=${value}${info != null ? ` (${info})` : ""}`);
    this.name = "Abort";
    this[AssertionTag] = condition;
  }
}

class CustomOutput extends ProcessOutput {
  toStdout(buffer: string, eol?: boolean): boolean {
    if (buffer) {
      return super.toStdout(buffer, eol);
    }
    return false;
  }
  toStderr(buffer: string, eol?: boolean): boolean {
    if (buffer) {
      return super.toStdout(buffer, eol);
    }
    return false;
  }
}

class CustomLogger extends ListrLogger {
  skippable = new Set();

  constructor(public omitFailMessages: boolean) {
    super({
      useIcons: false,
      processOutput: new CustomOutput(),
      fields: {
        prefix: [
          {
            condition: true,
            field: getFormattedTimestamp,
            format: () => color.dim as never,
          },
        ],
      },
    });
  }

  protected format(
    level: string,
    message: string | any[],
    options?: LoggerFieldOptions<false> | undefined
  ): string {
    if (this.omitFailMessages && level === ListrLogLevels.FAILED) {
      return "";
    }
    if (level !== ListrLogLevels.COMPLETED || !this.skippable.has(message)) {
      level === ListrLogLevels.COMPLETED && this.skippable.add(message);
      const tag =
        level === ListrLogLevels.STARTED
          ? "-->"
          : level === ListrLogLevels.COMPLETED
          ? "=*="
          : level;
      return super.format("", `[${tag}] ${message}`, options);
    } else {
      return "";
    }
  }
}

function undoTitleRewriteOnError(wrapper: any) {
  if (!wrapper.__LS__report) {
    wrapper.__LS__report = wrapper.report;
    wrapper.report = customReport.bind(wrapper);
  }
}

function customReport(this: any, error: unknown, type: unknown) {
  this.__LS__report?.(error, type);
  if (this.task?.title) {
    this.task.message$ = { error: this.task.title };
  }
}

function formatDuration(millis: number) {
  return (millis / 1000).toFixed(1) + "s";
}

function getFormattedTimestamp() {
  return formatTimestamp(new Date());
}

function formatTimestamp(time: Date) {
  return (
    String(time.getHours()).padStart(2, "0") +
    ":" +
    String(time.getMinutes()).padStart(2, "0") +
    ":" +
    String(time.getSeconds()).padStart(2, "0") +
    "." +
    String(time.getMilliseconds()).padStart(3, "0")
  );
}

function formatTimeFrame([start, end]: Date[]): string {
  const diff = end ? end.getTime() - start.getTime() : 0;
  if (diff < 1000) {
    return `[${formatTimestamp(start)}]`;
  }

  const prefix = formatTimestamp(start).slice(0, -4);
  const age =
    diff > 999000
      ? (diff / 1000 / 60).toFixed(0) + "m"
      : (diff / 1000).toFixed(0).padStart(3, "0");

  return `[${prefix}${age.length !== 3 ? "####" : "+" + age}]`;
}

type DecoratorConfig = {
  getTag: Worker["getTag"];
  timestamp?: boolean;
};

export function decorateLines(
  config: DecoratorConfig,
  input: string | Readable
): Transform;
export function decorateLines(
  config: DecoratorConfig,
  input: string | Readable,
  destination: NodeJS.WritableStream
): NodeJS.WritableStream;
export function decorateLines(
  { getTag, timestamp }: DecoratorConfig,
  input: string | Readable,
  destination?: NodeJS.WritableStream
): NodeJS.WritableStream {
  const source = typeof input === "string" ? Readable.from(input) : input;
  let lineTag: string | undefined;
  const getLineTag = (): string => {
    if (lineTag != null) {
      return lineTag;
    }
    const tag = getTag({ colored: true }).split(LS)[0];
    lineTag = tag ? tag + " " : "";
    return lineTag;
  };
  const transform = source.pipe(
    createLineDecorator((timeFrame) => {
      return timestamp === false
        ? getLineTag()
        : formatTimeFrame(timeFrame) + " " + getLineTag();
    })
  );
  if (destination) {
    return transform.pipe(destination, { end: false });
  } else {
    return transform;
  }
}

export function createLineDecorator(
  formatPrefix: (timeFrame: [Date] | [Date, Date]) => string
): Transform {
  let fragment = "";
  let fragmentStart = new Date();

  function sendChunk(chunk: unknown, callback: (i: null, v: string) => void) {
    const now = new Date();
    const buffer = fragment + chunk + "*";
    const lines = buffer.split(LS);
    if (lines.length === 1) {
      fragmentStart = fragment ? fragmentStart : now;
      fragment = buffer.slice(0, -1);
      callback(null, "");
      return;
    }

    const lastLine = lines.at(-1);
    if (lastLine === "*") {
      fragment = "";
    } else {
      fragment = lastLine?.slice(0, -1) ?? "";
      fragmentStart = now;
    }
    lines.splice(lines.length - 1, 1);
    const output =
      formatPrefix(fragment ? [fragmentStart, now] : [now]) +
      lines.join(EOL + formatPrefix([new Date()]));
    callback(null, output + EOL);
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      sendChunk(chunk, callback);
    },
    flush(callback) {
      if (fragment) {
        sendChunk(EOL, callback);
      } else {
        callback(null, "");
      }
    },
  });
}

function nonNull<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error(`Missing expected value, found ${value}`);
  }
  return value;
}

function asList<T>(container: T | T[] | null): T[] {
  return container === null
    ? []
    : Array.isArray(container)
    ? container
    : [container];
}

function getTitle(fn: Function) {
  if (!fn.name) {
    throw new Error(`Missing name for function **${fn}**`);
  }
  return rephrase(String(fn.name));
}

function rephrase(original: string): string {
  const withSpacing = original.includes(" ")
    ? original
    : original.includes("_")
    ? original.replace(/_/g, " ")
    : original
        .replace(/[A-Z][a-z]/g, (m) => " " + m.toLowerCase())
        .replace(/[A-Z]{2,}/g, (m) => " " + m)
        .replace(/[^\sa-zA-Z]+/g, (m) => " " + m);
  return withSpacing.trim().replace(/^./, (m) => m.toUpperCase());
}
