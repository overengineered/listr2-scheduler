import { Readable, Transform } from "node:stream";
import { EOL } from "node:os";
import { gray, dim, yellow } from "colorette";
import {
  Listr,
  ListrLogger,
  ListrLogLevels,
  ListrTask,
  LoggerFieldOptions,
  ProcessOutput,
} from "listr2";

export interface Toolkit {}

export type Worker = {
  data: Record<string, unknown>;
  reportStatus(text: string): void;
  updateTitle(title: string): void;
  pipeTagged(
    source: Readable,
    destination: NodeJS.WritableStream,
    options?: { timestamp?: boolean; letter?: Letter }
  );
  toolkit: Toolkit;
};

export type Driver<Keys extends string> = {
  run: (
    options: {
      printer: "verbose" | "vivid";
      dryRun?: boolean;
    } & (keyof Toolkit extends never
      ? { toolkit?: Toolkit }
      : { toolkit: Toolkit }),
    config?: Partial<Record<Keys, unknown>>
  ) => Promise<void>;
};

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
type _L1 = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";
type _L2 = "K" | "L" | "M" | "N" | "O" | "P" | "Q" | "R" | "S" | "T";
type Letter = _L1 | _L2 | "U" | "V" | "W" | "X" | "Y" | "Z";

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
  logger?: ListrLogger;
  toolkit: Toolkit;
};

export function schedule<Keys extends string = string>(
  define: Configurator<Keys>
): Driver<Keys> {
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
        [...inputs].filter((key) => config && config[key] !== undefined)
      );
      const isReady = (step: Step) => step.input.every((key) => done.has(key));
      for (const key of inputs) {
        validate(runnable, key, [], done, isReady);
      }

      const logger = new CustomLogger();

      if (options.printer === "verbose" && runnable.length < steps.length) {
        for (const skipped of steps) {
          if (!runnable.includes(skipped)) {
            logger.log(ListrLogLevels.SKIPPED, `${skipped.title}`);
          }
        }
      }

      const remaining = new Set(runnable);
      const ready = runnable.filter(isReady);
      ready.forEach((step) => remaining.delete(step));
      const runtime: Runtime = {
        data: { ...config },
        done,
        waiting: remaining,
        dryRun: !!options.dryRun,
        logger: options.printer === "verbose" ? logger : undefined,
        toolkit: options.toolkit ?? {},
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

      logger.log("FINISHED", formatDuration(Date.now() - start));
    },
  };
}

function createTask(step: Step, runtime: Runtime): ListrTask {
  const { data, done, waiting, logger } = runtime;
  return {
    title: step.title + " " + yellow(step.id),
    skip: () => !step.isQualified(data),
    task: async (_, executor) => {
      const state = {
        start: Date.now(),
        title: step.title,
        isFinished: false,
        update: () => {
          const passed = formatDuration(Date.now() - state.start);
          executor.title = state.title + " " + dim(gray(passed));
        },
      };
      undoTitleRewriteOnError(executor);
      const worker: Worker = {
        data,
        reportStatus: (text) => !state.isFinished && (executor.output = text),
        updateTitle: (title) => !state.isFinished && (state.title = title),
        pipeTagged(source, destination, { timestamp = true, letter } = {}) {
          if (state.isFinished) {
            throw new Error(`Task "${step.title}" is already finished`);
          }
          const prefix = (letter ?? "").slice(0, 1).toUpperCase();
          source
            .pipe(addLinePrefix({ timestamp, tag: prefix + step.id }))
            .pipe(destination, { end: false });
        },
        toolkit: runtime.toolkit,
      };
      const job = runtime.dryRun ? Promise.resolve() : step.run(worker);
      const result = await Promise.race([job, periodicUpdate(state)]);
      state.isFinished = true;
      state.title = step.title;
      !logger && (executor.output = "");
      state.update();
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
            ready.map((next) => createTask(next, runtime))
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

  constructor() {
    super({
      useIcons: false,
      processOutput: new CustomOutput(),
      fields: {
        prefix: [
          {
            condition: true,
            field: getFormattedTimestamp,
            format: () => dim as never,
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

function customReport(error: unknown, type: unknown) {
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

function addLinePrefix(options: {
  timestamp: boolean;
  tag?: string;
}): Transform {
  let fragment = "";
  let fragmentStart = new Date();
  return new Transform({
    transform(chunk, encoding, callback) {
      const now = new Date();

      const buffer = fragment + chunk + "*";
      const lines = buffer.split(/\r?\n/);
      if (lines.length === 1) {
        fragmentStart = fragment ? fragmentStart : now;
        fragment = buffer.slice(0, -1);
        callback(null, "");
        return;
      }

      const diff = fragment ? now.getTime() - fragmentStart.getTime() : 0;
      const tag = options.tag ? options.tag + " " : "";
      const prefix = `[${formatTimestamp(now)}] ${yellow(tag)}`;

      const timeInfo = formatTimestamp(fragmentStart);
      const age =
        diff > 999000
          ? (diff / 1000 / 60).toFixed(1).padStart(6, "0")
          : (diff / 1000).toFixed(0).padStart(3, "0");
      const displayTimeInfo =
        diff < 1000 ? timeInfo : timeInfo.slice(0, -age.length - 1) + "+" + age;

      const fragmentPrefix = fragment
        ? `[${displayTimeInfo}] ${yellow(tag)}`
        : prefix;

      const lastLine = lines.at(-1);
      if (lastLine === "*") {
        fragment = "";
      } else {
        fragment = lastLine?.slice(0, -1) ?? "";
        fragmentStart = now;
      }
      lines.splice(lines.length - 1, 1);
      const output = lines.join(EOL + prefix);
      callback(null, fragmentPrefix + output + EOL);
    },
    flush(callback) {
      callback(null, fragment);
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
