# Scheduler

Whatever wakes the loop on a cadence. Autopilot ships one command for it and one template.

```
cron / launchd / a CI schedule
            │
            ▼
   autopilot wake --config <product>
            │
     ┌──────┴──────┐
     │  one cycle  │  next unblocked ticket, or a self-audit on an empty backlog
     └──────┬──────┘
            ▼
      the digest        what reached staging, or silence
            │
            ▼
    exit 0 / 2 / 1      did work / nothing to do / failed
```

## Why `wake` and not `loop` then `digest`

A scheduler wants one command and one exit code. Two commands means a wrapper script, and
every person wiring this up would write the same one and get the exit code wrong in the same
place. `wake` runs the cycle, then the digest, and returns the cycle's exit code.

The digest runs **even when the cycle failed.** A failed run is the case a person most needs to
hear about, so staying quiet on failure would hide exactly the wake worth reading.

## Waking twice is safe

`integrations/README.md` states the one property a scheduler must not break: waking twice while
a ticket is in flight must not start it twice. The lock is the ticket state in the tracker, not a
local file, and `pickNext` resumes a started ticket before beginning a new one. So overlapping
wakes re-enter the same ticket on the same branch rather than racing.

## Local (launchd) - required when the deploy needs this machine

Use this when the product's staging deploy cannot run anywhere else. Reco is the clear case: its
staging deploy installs onto a physical iPad attached to a Mac, so no hosted runner can do it.

1. Find your absolute paths. Both matter, because launchd reads no shell profile:

   ```bash
   command -v node                    # ABSOLUTE_PATH_TO_NODE
   pwd                                # ABSOLUTE_PATH_TO_AUTOPILOT, run from the checkout
   ```

2. Copy the template and fill in every `ALL_CAPS` placeholder:

   ```bash
   cp integrations/scheduler/com.autopilot.wake.plist ~/Library/LaunchAgents/
   $EDITOR ~/Library/LaunchAgents/com.autopilot.wake.plist
   ```

3. Rehearse once by hand, before letting launchd near it. This spends no model call and writes
   nothing:

   ```bash
   node --experimental-strip-types packages/core/src/cli.ts wake \
     --config <product>/autopilot.config.json --dry-run --fake
   ```

   Read the prompt it prints. That is what the agent will receive at 3am.

4. Load it:

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.autopilot.wake.plist
   launchctl print gui/$(id -u)/com.autopilot.wake | head -20
   ```

5. Fire it once on purpose and read the log:

   ```bash
   launchctl kickstart -p gui/$(id -u)/com.autopilot.wake
   tail -f .autopilot/wake.log
   ```

   You know it worked when the log holds a cycle line and either a digest or
   `Nothing landed on staging. Silence is correct.`

To stop it: `launchctl bootout gui/$(id -u)/com.autopilot.wake`.

### The log grows forever

`StandardOutPath` appends and nothing rotates it. A wake writes a few lines, so this takes a
long time to matter, but it never stops. Truncate it when you notice, or hand it to `newsyslog`:

```bash
: > .autopilot/wake.log                     # truncate now, safe while loaded
```

Deliberately not automated. A log rotator is a second scheduled thing to get wrong, and the
file is inside `.autopilot/`, which is already the directory you delete to start clean.

### Self-hosting protects itself

When the product being built is Autopilot, `boundaries.protectedPaths` covers the gate, the
boundary check, the engineer runner, the release path and `prompts/`. The loop cannot edit the
code that decides whether the loop may ship, and it cannot rewrite its own instructions. It can
still extend `DESIGN.md`, `CONTEXT.md` and `docs/adr/`, which is what the anchor is for.

### When it runs by hand and not from launchd

Almost always one of three things, in this order:

| Symptom in the log | Cause |
| -- | -- |
| `command not found: git` / `pnpm` | `PATH` in the plist is missing the directory that holds it |
| the tracker rejects every call | `LINEAR_API_KEY` is not in the plist; launchd does not inherit your exports |
| nothing in the log at all | `StandardOutPath` points somewhere unwritable, or the plist never loaded |

`launchctl print gui/$(id -u)/com.autopilot.wake` shows the last exit status, which tells you
which of the three you have.

## Hosted (a CI schedule)

Only for a product whose staging deploy can run on a hosted runner. It needs two things the
local route does not: credentials for the coding agent in CI, and the product's deploy
credentials in CI. Both are a larger trust step than a machine you already sign in on, so this
is deliberately not the default and no workflow ships here yet. When a product needs it, the
shape is one scheduled job running the same `autopilot wake` command.

## Cadence

`StartInterval` is how often work moves, not how long a run takes. A wake does one cycle and
stops. Four hours is a reasonable start: slow enough that a person can read a digest between
wakes, fast enough that a day moves several tickets.
