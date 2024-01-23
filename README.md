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

## Configuration

Besides `"vivid"` printer (which uses default Listr2 renderer with some customizations)
`listr2-scheduler` offers only `"verbose"` alternative which prints all events with
timestamp prefix.

Conditional tasks can be declared by using `?` or `!` prefix in input keys. Tasks can
have more than one input. Tasks can have maximum one output.

```TypeScript
const ci = Boolean(process.env.CI);

schedule<"ci" | "silent" | "testResults" | "fmtResults">((when, make) => {
  when("?ci", make("testResults")).call("All tests", runAllTests);
  when("!ci", make("testResults")).call("Quick tests", runQuickTests);
  when(null, make("fmtResults")).call("Check code formatting", runPrettier);
  when(["!ci", "!silent", "fmtResults", "testResults"]).call("Finish", showDoneAlert);
}).run({ printer: ci ? "verbose" : "vivid" }, { ci });
```

When `call` is provided only executor function, it constructs task title from
function name, but task title can be provided separately as shown above.

## Executor functions

Executor functions for `listr2-scheduler` receive one argument of type `Worker` that
supports narrower capabilities than functions executed with pure `Listr2`.

```TypeScript
export type Worker = {
  data: Record<string, unknown>;
  reportStatus(text: string): void;
  updateTitle(title: string): void;
  pipeTagged(
    source: Readable,
    destination: NodeJS.WritableStream,
    options?: { timestamp?: boolean }
  );
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
