# Opinionated library for declaring Listr2 task structure

[Listr2](https://listr2.kilic.dev) is a very flexible library for running tasks that
depend on each other and it allows presenting task status in a beatiful way.
However declaring how to run those tasks is rather tedious. Listr2 has 4 renderers
but neither is an optimal default for 2 common use cases where complex scripts are used:
CI and developer machine. `listr2-scheduler` is an attempt to address those shortcomings.

## Simple example

```TypeScript
import { schedule } from "listr2-scheduler";

const driver = schedule((when, make) => {
  when(null, make("bundle")).call(createAppBundle);
  when("bundle").call(uploadAppToStaging);
  when("bundle").call(uploadBundleMapFileForCrashAnalytics);
});

driver.run({ printer: "vivid" });
```

Hopefully it's obvious that `createAppBundle` function will be executed at the beginning
and after it finishes `uploadAppToStaging` and `uploadBundleMapFileForCrashAnalytics` will
be executed in parallel. Here's equivalent ordering in pure Listr2:

```TypeScript
import { Listr } from "listr2";

new Listr(
  [
    {
      title: "Create app bundle",
      task: async (_, task) => {
        await createAppBundle();

        return task.newListr(
          [
            {
              title: "Upload app to staging",
              task: uploadAppToStaging,
            },
            {
              title: "Upload bundle map file for crash analytics",
              task: uploadBundleMapFileForCrashAnalytics,
            },
          ],
          { concurrent: true }
        );
      },
    },
  ],
  {
    renderer: "default",
    rendererOptions: {
      collapseSubtasks: false,
    },
  }
).run();
```

Besides `"vivid"` printer (which uses default Listr2 renderer with some customizations)
`listr2-scheduler` offers only `"verbose"` alternative which prints all events with
timestamp prefix.

## Configuration

When `call` is provided only executor function, it constructs task title from
function name, but task title can be provided separately as shown below.

Conditional tasks can be declared by using `?` or `!` prefix in input keys. Tasks can
have more than one input. Tasks can have maximum one output.

```TypeScript
const ci = Boolean(process.env.CI);

schedule<"ci" | "silent" | "testResults" | "fmtResults">((when, make) => {
  when("?ci", make("testResults")).call("All tests", runAllTests);
  when("!ci", make("testResults")).call("Quick tests", runQuickTests);
  when(null, make("fmtResults")).call("Check code formatting", runPrettier);
  when(["!ci", "!silent", "fmtResults", "testResults"]).call("Finish", showDoneAlert);
}).run({ printer: ci ? "verbose" : "vivid" }, { ci, silent: false });
```

For task to start values for all the input keys have to be provided either by config
parameter (the second argument to run) or by another task as a result value. When task
input key is prefixed with `?` the value provided must be truthy, when prefix is `!` value
must be falsy. If value does not match requirements, task is skipped. When there's no
prefix in the key any value for that key is allowed, including `undefined` and `null`.
However config passed to run cannot provide `undefined` values. Any keys that are
`undefined` in config must be provided by tasks.

## Executor functions

Executor functions for `listr2-scheduler` receive one argument of type `Worker` that
allows task to update task rendering and execution.

```TypeScript
export type Worker<T = any> = {
  data: T;
  reportStatus(text: string): void;
  updateTitle(title: string): void;
  pipeTagged(
    source: Readable,
    destination: NodeJS.WritableStream,
    options?: { timestamp?: boolean; letter?: Letter }
  ): void;
  on(event: "finalize", callback: (error: unknown, executor: unknown) => void): void;
  assertCanContinue(tag?: string): void;
  toolkit: Toolkit;
};
```

- `data` is an object that is given as a second argument to `run` function, and it
  is augmented by return values of executor functions.

- `reportStatus` prints task status in both `"verbose"` and `"vivid"` modes.

- `updateTitle` only updates task title in `"vivid"` mode.

- `pipeTagged` allows piping output from subprocesses to stdout or stderr with worker
  id and optionally with timestamp (default is with timestamp) and optionally with
  identifier letter.

```TypeScript
const sub = execa("ping", ["-c", "3", "npmjs.com"]);
sub.stdout && worker.pipeTagged(sub.stdout, process.stdout);
sub.stderr && worker.pipeTagged(sub.stderr, process.stdout, { letter: 'E' });
await sub;
```

- `on` allows executor to be informed about errors in other parallely running executors.
  **NOTE**: Only the last registered callback will be invoked.

```JavaScript
async function prepareTestFiles(worker) {
  const controller = new AbortController();
  worker.on('finalize', () => controller.abort());
  await fetch(testFilesBundleUrl, { signal: controller.signal });
}
```

- `assertCanContinue` throws if some parallel executor has thrown an exception.

```JavaScript
async function analyzeSourceFiles(worker) {
  let completed = 0;
  for (const filePath of all) {
    worker.reportStatus('Analyzing ' + filePath);
    await analyzeFile(filePath);
    completed += 1;
    worker.assertCanContinue('Analyzed ' + completed + '/' + all.length);
  }
}
```

- `toolkit` is by default an empty object. It's type can be augmented with TypeScript
  declaration and it can be provided with an argument to `run`.

```TypeScript
import { schedule } from "listr2-scheduler";

declare module "listr2-scheduler" {
  interface Toolkit {
    download: (url: string) => Promise<Maybe<Buffer>>;
  }
}

schedule((when) => {
  when(null).call("Fetch lint rules", ({ toolkit }) => toolkit.download(lintUrl));
}).run({ printer: "verbose", toolkit: { download } });
```
