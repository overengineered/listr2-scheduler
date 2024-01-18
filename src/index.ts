import { gray, dim, strikethrough } from "colorette";
import {
  Listr,
  ListrRendererFactory as _LRF,
  ListrTaskWrapper,
  ListrTask,
  ListrLogger,
  ListrLogLevels,
  LoggerFieldOptions,
} from "listr2";

type Executor = ListrTaskWrapper<unknown, _LRF, _LRF>;

type Output<T> = { key: T };
type ConfigShape = Record<string, unknown>;

type Actions = {
  call: ((task: () => Promise<unknown>) => void) &
    ((label: string, task: () => Promise<unknown>) => void);
};

type Pattern<K extends string> = K | `?${K}` | `!${K}`;

type Matcher<T extends ConfigShape, K extends keyof T & string> = ((
  condition: Pattern<K> | Pattern<K>[] | null
) => Actions) &
  (<R extends K>(condition: K | K[] | null, output: Output<R>) => Actions);

type DefineFn<T extends ConfigShape, K extends keyof T & string> = (
  when: Matcher<T, K>,
  make: <R extends K>(key: R) => Output<R>
) => void;

type Step = {
  title: string;
  filters: Pattern<string>[];
  input: string[];
  output?: Output<string>;
  run: (options: { data: Record<string, unknown> }) => unknown;
};

export type Driver<T extends object> = {
  run: (
    options: {
      printer: "verbose" | "vivid";
      dryRun?: boolean | number;
    },
    config?: Partial<T>
  ) => Promise<void>;
};

export function schedule<T extends ConfigShape, K extends keyof T & string>(
  define: DefineFn<T, K>
): Driver<T> {
  const steps: Step[] = [];
  const when: Matcher<T, K> = (
    condition: Pattern<K> | Pattern<K>[] | null,
    output?: Output<K>
  ) => ({
    call: (nameSource: (() => unknown) | string, fn?: () => unknown) => {
      const run = typeof nameSource === "function" ? nameSource : nonNull(fn);
      const title = typeof nameSource === "string" ? nameSource : getTitle(run);
      const input: string[] = [];
      const filters: Pattern<string>[] = [];
      asList(condition).forEach((pattern) => {
        if (pattern.startsWith("!") || pattern.startsWith("?")) {
          input.push(pattern.slice(1));
          filters.push(pattern);
        } else {
          input.push(pattern);
        }
      });
      steps.push({ title, filters, input, output, run });
    },
  });
  const make: <R extends K>(key: R) => Output<R> = (key) => ({ key });

  define(when, make);

  return {
    run: async (options, config) => {
      const inputs = new Set(steps.flatMap((step) => step.input));
      const done = new Set(
        [...inputs].filter((key) => config && config[key] !== undefined)
      );
      const isReady = (step: Step) => step.input.every((key) => done.has(key));
      for (const key of inputs) {
        validate(steps, key, [], isReady);
      }

      const data = { ...config };
      const eventLogger = new AlignedLogger();
      const remaining = new Set(steps);
      const ready = steps.filter(isReady);
      ready.forEach((step) => remaining.delete(step));
      const logger = options.printer === "verbose" ? eventLogger : undefined;
      const tasks = ready.map((step) =>
        createTask(step, done, remaining, data, logger)
      );

      const start = Date.now();
      await new Listr(tasks, {
        concurrent: true,
        ...(options.printer === "vivid"
          ? {
              renderer: "default",
              rendererOptions: {
                collapseSubtasks: false,
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
  logger?: ListrLogger
): ListrTask {
  return {
    title: step.title,
    task: async (_, executor) => {
      const details = { title: step.title, executor, isFinished: false };
      const result = await Promise.race([
        step.run({ data }),
        updateTiming(details),
      ]);
      details.isFinished = true;
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
            logger.log(ListrLogLevels.TITLE, executor.title);
            executor.title = step.title;
          }
          return executor.newListr(
            ready.map((next) => createTask(next, done, waiting, data, logger))
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
  isRoot: (step: Step) => boolean
): void {
  const preceding = steps.filter((t) => t.output?.key === key);
  if (preceding.length === 0) {
    throw new Error(`Cannot reach "${key}"`);
  }
  const remaining = preceding.filter((t) => !isRoot(t));
  for (const option of remaining) {
    if (visited.includes(option)) {
      const cycle = [...visited, option].map((it) => it.title).join("->");
      throw new Error(`Unreachable cycle found "${cycle}"`);
    }
    const optionPath = visited.concat(option);
    for (const target of option.input) {
      validate(steps, target, optionPath, isRoot);
    }
  }
}

function updateTiming(details: {
  title: string;
  executor: Executor;
  isFinished: boolean;
}) {
  const start = Date.now();
  let end = (value?: never): unknown => void value;
  const promise = new Promise<undefined>((res) => (end = res));
  const periodicTicker = setInterval(() => {
    if (details.isFinished) {
      end();
      clearInterval(periodicTicker);
    } else {
      const passed = formatDuration(Date.now() - start);
      details.executor.title = details.title + " " + dim(gray(passed));
    }
  }, 125);
  return promise;
}

class AlignedLogger extends ListrLogger {
  constructor() {
    super({
      useIcons: false,
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
    const tag =
      level === ListrLogLevels.STARTED
        ? "-->"
        : level === ListrLogLevels.TITLE
        ? "..."
        : level === ListrLogLevels.COMPLETED
        ? "=*="
        : level;
    return super.format("", `[${tag}] ${message}`, options);
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

function getTitle(fn: () => unknown) {
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
