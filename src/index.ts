import { gray, dim } from "colorette";
import {
  Listr,
  ListrLogger,
  ListrLogLevels,
  ListrTask,
  LoggerFieldOptions,
  ProcessOutput,
} from "listr2";

type Output<T> = { key: T };

type Actions = {
  call: ((task: (worker: Worker) => Promise<unknown>) => void) &
    ((label: string, task: (worker: Worker) => Promise<unknown>) => void);
};

type Pattern<T extends string> = T | `?${T}` | `!${T}`;

type Matcher<T extends string> = ((
  condition: Pattern<T> | Pattern<T>[] | null
) => Actions) &
  (<R extends T>(
    condition: Pattern<T> | Pattern<T>[] | null,
    output: Output<R>
  ) => Actions);

type DefineFn<T extends string> = (
  when: Matcher<T>,
  make: <R extends T>(key: R) => Output<R>
) => void;

export interface Worker {
  data: Record<string, unknown>;
  reportStatus(text: string): void;
  updateTitle(title: string): void;
}

type Step = {
  title: string;
  isQualified: (config: Record<string, unknown>) => boolean;
  input: string[];
  output?: Output<string>;
  run: (worker: Worker) => unknown;
};

export type Driver<T extends string> = {
  run: (
    options: {
      printer: "verbose" | "vivid";
      dryRun?: boolean;
    },
    config?: Partial<Record<T, unknown>>
  ) => Promise<void>;
};

export function schedule<T extends string>(define: DefineFn<T>): Driver<T> {
  const steps: Step[] = [];
  const when: Matcher<T> = (
    condition: Pattern<T> | Pattern<T>[] | null,
    output?: Output<T>
  ) => ({
    call: (
      nameSource: ((worker: Worker) => unknown) | string,
      fn?: (worker: Worker) => unknown
    ) => {
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
      steps.push({ title, isQualified, input, output, run });
    },
  });
  const make: <R extends T>(key: R) => Output<R> = (key) => ({ key });

  define(when, make);

  return {
    run: async (options, config) => {
      const runnable = steps.filter((it) => it.isQualified(config));
      const inputs = new Set(runnable.flatMap((step) => step.input));
      const done = new Set(
        [...inputs].filter((key) => config && config[key] !== undefined)
      );
      const isReady = (step: Step) => step.input.every((key) => done.has(key));
      for (const key of inputs) {
        validate(runnable, key, [], done, isReady);
      }

      const data = { ...config };
      const eventLogger = new CustomLogger();

      if (options.printer === "verbose" && runnable.length < steps.length) {
        for (const skipped of steps) {
          if (!runnable.includes(skipped)) {
            eventLogger.log(ListrLogLevels.SKIPPED, `${skipped.title}`);
          }
        }
      }

      const remaining = new Set(runnable);
      const ready = runnable.filter(isReady);
      ready.forEach((step) => remaining.delete(step));
      const logger = options.printer === "verbose" ? eventLogger : undefined;
      const tasks = ready.map((step) =>
        createTask(step, done, remaining, data, options.dryRun, logger)
      );

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

      eventLogger.log("FINISHED", formatDuration(Date.now() - start));
    },
  };
}

function createTask(
  step: Step,
  done: Set<string>,
  waiting: Set<Step>,
  data: Record<string, unknown>,
  dryRun: boolean,
  logger?: ListrLogger
): ListrTask {
  return {
    title: step.title,
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
      };
      const job = dryRun ? Promise.resolve() : step.run(worker);
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
            ready.map((next) =>
              createTask(next, done, waiting, data, dryRun, logger)
            )
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
  }
  toStderr(buffer: string, eol?: boolean): boolean {
    if (buffer) {
      return super.toStdout(buffer, eol);
    }
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
  const now = new Date();
  return (
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0") +
    "." +
    String(now.getMilliseconds()).padStart(3, "0")
  );
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
