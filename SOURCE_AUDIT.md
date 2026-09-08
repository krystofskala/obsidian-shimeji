# Source audit tracker

Working checklist for auditing this plugin's engine against the real shimeji-ee Java source
(`com.group_finity.mascot.*`), file by file. This is a working document for whoever (human or
Claude) picks this up next — it is not user-facing; see `README.md` for the polished narrative
of what's ported and why. Update this file as you go instead of re-deriving status from scratch
or from conversation memory each session.

**Golden rule established this session**: never guess/invent physics or timing. Pull the actual
Java source and read it before changing or claiming anything about "real" behavior.

## Getting the real source

`WebFetch` paraphrases/summarizes Java source instead of returning it verbatim — unusable for an
exact port. Fetch real bytes instead.

### Ground truth (updated 2026-08-13): `DalekCraft2/Shimeji-Desktop`

Kilkakon is the actual current maintainer of shimeji-ee — active as of an August 2025 Patreon
post — but has no public git repo of his own; he distributes via kilkakon.com/shimeji and
Patreon only. `logany20/shimeji-ee` (the source used for every audit pass through Pass 10, see
below) turned out to be from an **older, divergent lineage that stops before Kilkakon's
v1.0.14** — it is missing an entire subsystem (Affordances, Scan actions, BreedMove/BreedJump,
Transients — the real mechanism behind mascot-to-mascot targeting) that ships in Kilkakon's
actual current releases.

`DalekCraft2/Shimeji-Desktop` contains isolated, individually-verifiable commits that import
Kilkakon's own unmodified source, version by version. Use these as ground truth going forward:

| Commit    | Contents                                              |
|-----------|--------------------------------------------------------|
| `e5616e5` | "Import the source of the original Shimeji Desktop" — a pristine, zero-third-party-modification snapshot of Kilkakon's source at **v1.0.19** (280 files, all pure additions — confirmed via `git show --stat` and `kilkakon.txt` inside the commit) |
| `1fc2bf6` | Merge changes from version 1.0.20 |
| `025e49e` | Merge changes from versions 1.0.21 and 1.0.21.1 |
| `6f6ce4b` | Merge changes from 1.0.21.2 |
| `8eda881` | Merge changes from 1.0.21.3 |
| `16ee0e8` | Merge changes from 1.0.22 (current tip as of this audit) |

Each version-merge commit's diff-stat was checked against `kilkakon.txt`'s own changelog entry
for that version and touches only the files that entry describes — these are genuinely
Kilkakon's own diffs, not a third party's reinterpretation.

```bash
# Full tree, deep history (needed to find the isolated version-import commits above):
git clone --depth 1 --filter=blob:none --sparse https://github.com/DalekCraft2/Shimeji-Desktop.git <dest>
cd <dest> && git sparse-checkout set --no-cone '/*'
git fetch --deepen=500 origin main   # shallow clone only shows 1 commit until deepened

# One file at a specific version:
curl -sS "https://raw.githubusercontent.com/DalekCraft2/Shimeji-Desktop/<commit>/src/main/java/com/group_finity/mascot/<path>.java"
```

**Package root differs from the old fork**: `src/main/java/com/group_finity/mascot/` (Maven
layout), not `src/com/group_finity/mascot/`. 119 Java files at the current tip vs. 68 in
`logany20` — 39 action classes vs. 18. New top-level packages `platform/` (cross-platform OS
abstraction) and `sound/`. The in-tree `kilkakon.txt` is Kilkakon's own versioned changelog
(v1.0.5 through v1.0.22) — read it first when investigating what changed and when.

A clone lives in scratchpad at `shimeji-desktop-latest/` (827 commits on `main` after
deepening) — re-clone with the commands above if it's gone; ephemeral scratchpad doesn't
survive between sessions.

**What this means for prior audit passes**: everything ported through Pass 10 was verified
against `logany20/shimeji-ee`. That fork is a reasonably faithful mirror of Kilkakon's source
*up through where it diverges* (roughly v1.0.13-era) — classes it shares with the new source
(`Mascot.java`, `Move.java`, `Fall.java`, the core physics/behavior loop, etc.) don't need
re-verification just because the ground truth moved. But treat any *specific* claim from an old
pass as unverified against post-1.0.13 evolution until re-checked — e.g. `Breed.java`'s own API
changed shape (params like `BornBehavior` became `BornBehaviour`) between the two lineages. New
work should read from `DalekCraft2/Shimeji-Desktop` first; fall back to `logany20/shimeji-ee`
(still cloned at `shimeji-ee-full/` in scratchpad) only for cross-checking or history.

### Superseded: `logany20/shimeji-ee` (primary source through Pass 10)

```bash
curl -sS "https://raw.githubusercontent.com/logany20/shimeji-ee/master/src/com/group_finity/mascot/<path>.java"
git clone --depth 1 --filter=blob:none --sparse https://github.com/logany20/shimeji-ee.git <dest>
cd <dest> && git sparse-checkout set src/com/group_finity/mascot
```

Still useful as a second, independently-sourced reference for the pre-1.0.14 core it does cover
(confirmed via `AnimationBuilder.java` and cross-checked against `gil/shimeji-ee`, itself
"based on Kilkakon's v1.0.13" per its own README). A prior partial checkout also lives in
scratchpad at `shimeji-src/` (hand-picked files, curl'd one at a time); the full sparse clone at
`shimeji-ee-full/` supersedes it.

## Status legend

- ✅ **Ported & verified** — read the real source, confirmed our TS matches (or matches with a
  deliberately-documented simplification).
- 🐛 **Bug found & fixed** — read the source, found a real divergence, fixed it, tested it.
- 📖 **Reviewed, no action** — read the source, it's pure structural/interface plumbing or dead
  code in the original with no behavioral consequence either way.
- ⛔ **Out of scope** — Java-desktop-only concern (Swing UI, JNA/OS native bridge, AWT image
  loading, app lifecycle) with no analog in an Obsidian plugin. Not a gap, just not applicable.
- ❓ **Not yet audited** — haven't read this file this project, or only inferred its behavior
  from callers/tests rather than reading it directly.

## `action/`

| File | Status | Notes |
|---|---|---|
| `Action.java` | 📖 | Bare interface (`init`/`hasNext`/`next`). Nothing to port. |
| `ActionBase.java` | ✅ | `hasNext()` = `Condition && time < Duration` (Duration default ≈ ∞) for *every* action. This is where the tickHold rewrite (2026-08-12) came from. Also: `getAnimation()` re-walks the variant list fresh *every single call* (called from inside `tick()`, i.e. every tick) rather than once — combined with `#{...}`'s per-tick cache-clear (see `script/Script.java`), this means condition-gated Animation variants can switch mid-action. Missed on the first read, caught on a second pass — see Pass 4. |
| `Animate.java` | ✅ | Adds `time < animation.getDuration()` on top of ActionBase — self-caps at one pose cycle. Now correctly modeled in `tickHold` (`selfCapsAtOneCycle`). |
| `BorderedAction.java` | ✅ | `LostGroundException` thrown identically by Move/Stay/Animate when their border vanishes mid-action. Ported as `isBorderLost`, shared by `tickMove` and `tickHold`. |
| `Breed.java` | ✅ | Extends `Animate` (self-caps). `breed()` at `time == animation.duration-1`, BornX sign-flips by facing, sibling inherits parent's facing. All ported. **Re-checked in Pass 10 specifically for proximity/distance dependence** (prompted by a direct question: does breeding depend on how close two *existing* mascots are?) — it doesn't. `breed()` only ever reads `getMascot().getAnchor()` (itself) and offsets by BornX/BornY; there is no `getMascots()`/distance/nearby concept anywhere in the condition or variable system (`VariableMap`/`MascotEnvironment`) at all. A new sibling is entirely self-generated by the breeding mascot, never gated on or aware of any other mascot's position. |
| `ComplexAction.java` / `Select.java` / `Sequence.java` | ✅ | `seek()`-driven child selection confirmed structurally equivalent to `tickSequence`/`tickSelect`. Per-child `Condition` comes from `ActionBase.hasNext()`, not a separate mechanism — matches `evaluateCondition(ref.condition, ctx)`. `Loop=` is a **Sequence-only** XML attribute in every real usage (confirmed via full-pack grep) — never used on Stay/Animate, which is exactly the wrong assumption the old `tickHold` was making before the 2026-08-12 fix. |
| `Dragged.java` | ✅ | Fully ported earlier this session (`tickDragFootX`, fixed anchor offset, no lerp). |
| `Fall.java` | ✅ | Wall-termination, per-tick facing update, real resistance/gravity defaults (0.05/0.1/2) all ported. Sub-pixel "HACK IE" stepping loop deliberately not ported (guards against a fast-moving *tracked window*, not applicable to stable panes). |
| `FallWithIE.java` | ✅ | Extends `Fall`. Its own `moveActiveIE` snaps the window to the mascot's current anchor every tick (an absolute "glue the window to my feet" recompute, not an accumulated delta) — this specific phase is a brief, `Velocity="0,0"` grab/attach pose, so that snap never actually moves anything in practice; the pane only starts changing once `WalkWithIE` begins actually walking (see its own row and Pass 8). Mapping the mascot's own physics to plain `Fall` remains correct. |
| `InstantAction.java` | ✅ | `apply()` once at `init()`, `hasNext()` permanently false after. Matches `frame.instantComplete` (Look/Offset). |
| `Jump.java` | ✅ | Constant-speed direction-vector recomputed every tick, not gravity. Ported as `tickJump`. |
| `Look.java` | ✅ | Default `LookRight` is *toggle current facing*, not face-the-cursor. Fixed. |
| `Move.java` | ✅ | Confirmed via direct read 2026-08-12 (previously only inferred). Per-tick facing re-check while moving toward TargetX is a no-op for us since TargetX is fixed for a Move's lifetime (facing can't flip back mid-move) — start-once is equivalent. Target-snap-then-continue-one-more-tick vs our immediate-stop-on-crossing: already documented as a deliberate minor timing difference in README. |
| `Offset.java` | ✅ | Plain unconditional `(x+X, y+Y)`, never flipped by facing. Confirmed matches. |
| `Regist.java` | ✅ | Extends `ActionBase` directly (not Animate) — real "hold forever absent Duration" default is actually *correct* for it, unlike Breed/ThrowIE. Own `hasNext()` (cursor within 5px) and tick()-thrown `LostGroundException` are architecturally unreachable here (Dragged/Resisting render via a separate live-preview path with no interpreter tick during a drag) — documented dead path, not silently dropped. |
| `Stay.java` | ✅ | No extra cap beyond ActionBase — holds/cycles until Duration/Condition end it. This is the half of the 2026-08-12 tickHold bug that mattered most (multi-Pose Stay actions were self-ending after one pass instead of holding). |
| `ThrowIE.java` | 🐛 | **Extends `Animate`, not Fall.** Its own `tick()` never touches the mascot's position — `BorderType="Floor"`, single `Velocity="0,0"` pose — it only throws the *tracked window*: `moveActiveIE(activeIE.left ± InitialVX, activeIE.top + InitialVY + time*Gravity)`, called every tick, sign of the x term by facing. Was wrongly mapped to plain `Fall` (ran real falling physics on the mascot, which immediately "landed" again since it was already grounded, cutting the held pose short). Fixed 2026-08-12: routed through `tickHold` like Regist, added to the `selfCapsAtOneCycle` check like Breed. The window-throwing side effect itself — genuinely absent at the time of that fix — is now ported too, see Pass 8: `tickThrowIE` runs this exact formula against a real popped-out Obsidian window via `PaneActions.beginThrow`, gated behind the (default-off) "Window mischief" setting. |
| `WalkWithIE.java` | ✅ | Extends `Move`, adds IE-window-drag + IE-position-consistency `LostGroundException` checks: every tick, `moveActiveIE` snaps the window's position to the mascot's current anchor (offset by IeOffsetX/Y) — an absolute recompute from live position, not an accumulated delta, "the window is glued to my feet as I walk." An Obsidian pane can't be freely repositioned like an OS window (no analog for *that* exact mechanic — confirmed, see NativeFactory's row below), so Pass 8 reinterprets "carrying" as resizing instead: `tickWalkWithIE` forwards the mascot's own per-tick walk delta (identical physics to plain `Move`, which the mascot-position mapping already correctly used) to `PaneActions.resizeBy`. This is a deliberate Obsidian-native adaptation, not a literal port — see PaneActions.ts's own comment. |

## `animation/`

| File | Status | Notes |
|---|---|---|
| `Animation.java` | ✅ | `getPoseAt(time % totalDuration)` — always cycles by construction; termination is entirely the outer Action's job. This is the other half of the tickHold rewrite (`pickLoopingPose` already did this correctly for tickEmbedded; tickHold now uses it too instead of a linear poseIndex walk). |
| `Pose.java` | ✅ | `anchor.x += (lookRight ? -dx : dx); anchor.y += dy`. Confirmed matches our `physics.x += velocity.x * -facing * dt` sign convention. |

## `behavior/`

| File | Status | Notes |
|---|---|---|
| `Behavior.java` | 📖 | Bare interface, also declares `mousePressed`/`mouseReleased` (real engine routes mouse events through the active Behavior, not Mascot directly — we wire pointer events at the Mascot/PackDriver level instead, a reasonable adaptation). |
| `UserBehavior.java` | 🐛 | `next()`'s off-screen recovery (respawn + forced Fall), `catch (LostGroundException)` → forced Fall. Both ported. Also: `mouseReleased()` is `buildBehavior(BEHAVIORNAME_THROWN)`, unconditionally — no speed threshold, ever. Ours branched between forcing "Fall" or "Thrown" by a `minThrowSpeed` comparison; fixed in Pass 6 — `PackDriver.notifyReleased` now always forces "Thrown" (the *native-fallback* placeholder state machine, which has no real equivalent to be faithful to, keeps its own simpler two-state distinction). |

## `config/`

| File | Status | Notes |
|---|---|---|
| `ActionBuilder.java` | ✅ | `createVariables`: own params first, ActionReference-site overrides second (override wins). Matches our `locals` merge order. Type dispatch table (Move/Stay/Animate/Sequence/Select/Embedded) matches `KNOWN_TYPES`. |
| `ActionRef.java` | 📖 | `buildAction(params)` lets a ref's own params override an incoming caller map, but every real call site (`createActions()`) always passes an empty map — no observable effect in any real pack. Config-loader-internal, not user-visible. |
| `AnimationBuilder.java` | ✅ | Confirmed schema match (Velocity/ImageAnchor parsing) — this is what resolved the early `NextBehaviorList` vs `NextBehavior` naming worry. |
| `BehaviorBuilder.java` | ✅ | `Add` attribute default (false if the wrapper element exists, true if it doesn't) — confirmed our `BehaviorsParser.ts` already modeled this correctly. |
| `Configuration.java` | ✅ | `buildBehavior()`: NextBehavior gated only by its own condition (not the target's top-level condition — this was the pickNextBehavior bug, fixed), `totalFrequency==0` respawn recovery (fixed). |
| `Entry.java` | ✅ | Confirmed: a thin, lazily-memoized DOM wrapper (`getAttribute` via `getAttributeNode` specifically, so a genuinely-missing attribute reads as `null` — a workaround for the old W3C Java DOM binding's own `getAttribute` returning `""` instead; the browser DOM's native `Element.getAttribute` already returns `null` for a missing attribute, so we get the same correct result for free, no workaround needed on our side). No behavioral logic beyond what its callers already assumed. |
| `IActionBuilder.java` | 📖 | Bare interface (`validate`/`buildAction`). |

## `environment/`

| File | Status | Notes |
|---|---|---|
| `Area.java` | ✅ | Confirmed: `left/top/right/bottom` plus `dleft/dtop/dright/dbottom` (how much each edge moved since the last `.set()`) — exactly what `Wall`/`FloorCeiling.move()`'s already-declined-to-port proportional-rescale math consumes. Confirms that earlier decision was based on accurate understanding, nothing new. |
| `Border.java` | ✅ | Two-method interface (`isOn`/`move`) — matches our `Ledge` predicate + (deliberately unported) `move` proportional-rescale concept. |
| `ComplexArea.java` | ✅ | Confirmed: purely multi-monitor plumbing (a named collection of `Area`s keyed by OS display device ID, with a genuinely clever cross-monitor continuity trick in `getLeftBorder`/`getRightBorder` — walking off one screen's edge onto an adjacent screen's matching edge treats them as one continuous surface). Zero analog in a single-viewport Obsidian plugin; confirms `MascotEnvironment`'s multi-monitor concepts are correctly out of scope, not an oversight. |
| `Environment.java` | ✅ | Confirmed load-bearing, not just geometry plumbing: `this.cursor = new Location(); ... tick() { ...; this.cursor.set(getCursorPos()); }` — this is the real source of `mascot.environment.cursor.dx/dy`, and it's genuinely used by the standard pack (`Thrown`'s `InitialVX="${mascot.environment.cursor.dx}"`), not dead. See `Location.java` below — this is where Pass 6 came from. |
| `FloorCeiling.java` / `Wall.java` | ✅ | `move()`'s proportional-rescale-relative-to-a-moving-border math, deliberately not ported (our `findNearestFloorAt` re-snap approximates the same intent for a fundamentally different multi-pane model). |
| `Location.java` | 🐛 | `set(Point)`: `dx = (dx + (newX-x)) / 2` — an exponential smoothing of the raw per-tick pixel delta, called once per `Environment.tick()` (40ms). This **is** `mascot.environment.cursor.dx/dy`, and real `Thrown` reads it directly as release velocity (see `action/Thrown`'s `ActionReference` in actions.xml). Our old `computeReleaseVelocity` used an unrelated windowed-average of the *drag's own* pointer history, with a `dragThrowScale` tuning knob the real engine has no equivalent of. Fixed — see Pass 6. |
| `MascotEnvironment.java` | ✅ | Facing-dependent activeIE-vs-workArea border selection with `ignoreSeparator`/multi-monitor concepts. Judged too architecturally different from our N-pane model to port further — accepted, documented simplification (see README "Approximated, not literal"). |
| `NotOnBorder.java` | ✅ | Null-object "no border" (`isOn` always false). Matches our `undefined`-returning conventions. |

## `script/` (the `#{...}`/`${...}` expression language)

| File | Status | Notes |
|---|---|---|
| `Constant.java` | ✅ | Trivial literal wrapper (`get()` always returns the same stored value). Matches `parseParamValue`'s literal branch (number/bool/string). |
| `Script.java` | 🐛 | **`#{...}` and `${...}` are not the same thing** — real conditions/values are compiled and run as actual JavaScript (`ScriptEngineManager`/`"text/javascript"`, i.e. Nashorn), not a custom mini-language. `#{...}` (`clearAtInitFrame=true`) re-evaluates fresh every tick (`initFrame()` clears its cached value); `${...}` (`clearAtInitFrame=false`) evaluates once and stays cached for the rest of the action's lifetime. Our `Expression.ts` treated the two wrappers as pure syntax sugar (see the now-corrected comment that used to sit above `EXPR_WRAPPER`) — for **locals** (Duration/TargetX/BornX/...) this was accidentally fine, since `resolveLocals` already only runs once per `pushAction` regardless of syntax, matching `${...}`'s semantics by construction. For **Animation-variant selection** it wasn't: real `ActionBase.getAnimation()` re-walks the condition list fresh every tick (see the `action/ActionBase.java` row), which is precisely what `#{...}`'s per-tick cache-clear is *for*. Fixed 2026-08-12 — see Pass 4 below. |
| `Variable.java` | ✅ | `Variable.parse()`: `${...}` → `Script(clearAtInitFrame=false)`, `#{...}` → `Script(clearAtInitFrame=true)`, anything else → `Constant`. This is the dispatch the Pass 4 fix is based on. |
| `VariableMap.java` | ✅ | Implements `javax.script.Bindings` — this *is* the scope object the compiled JS runs against, which is how `mascot.anchor.x` in a condition ends up calling the real `Mascot`/`MascotEnvironment` Java getters via Nashorn's JS↔JavaBean property bridging. Confirms our custom recursive-descent parser (`Expression.ts`) is a deliberate, security-motivated divergence, not just a stylistic one: literally `eval()`/`new Function()`-ing pack-supplied script text would be an arbitrary-code-execution surface here in a way it isn't for the original desktop app (a Java process already has full OS access; an Obsidian plugin evaluating untrusted third-party pack content does not currently, and shouldn't gain it just to save writing a parser). Our restricted grammar (literals/paths/calls/unary/binary/ternary — no statements, no assignment, no arbitrary global access) is the correct adaptation, not a corner cut. |

Cross-checked every function call actually used across `actions.xml`/`behaviors.xml`'s real conditions (`Math.abs`, `Math.min`, `Math.random`, and every `...isOn(...)` predicate on `floor`/`ceiling`/`workArea.*Border`/`activeIE.*Border`) against `RuntimeContext.ts`'s `call()` — all present. `Math.random` deliberately routes through the engine's own seeded `Random` instead of the real `Math.random()`, for reproducible tests — consistent with the rest of the engine.

## `Manager.java` / `Mascot.java` (root)

| File | Status | Notes |
|---|---|---|
| `Manager.java` | 🐛 | Fixed 40ms tick (matches `ENGINE_FIXED_TICK_MS`), pending-add/remove buffering (Java concurrent-collection safety, irrelevant to single-threaded JS), two-phase tick-then-apply over all mascots. One confirmed-harmless divergence: a Breed-spawned sibling pushed onto `Stage.mascots` mid-iteration gets its own `simulate()` call in the *same* tick it's born (JS `for...of` observes live array growth; real Manager defers new mascots to the next tick via its `added` set). Fully-initialized by the time this happens, so not a crash risk — just one 40ms-early tick for a newborn. Not worth chasing. **`remainOne()`/`remainOne(imageSet)` — found genuinely missing in Pass 9, not just "already covered" as Pass 5 had incorrectly claimed.** `remainOne()` (no filter, tray's "Reduce to One!") keeps the mascot at index 0 (oldest) and disposes every other mascot regardless of character — a *third*, distinct population primitive from `disposeAll()` ("Bye Everyone!", zero left) that had been conflated with it. `remainOne(imageSet)` (the per-mascot menu's own "Reduce to One!", see `Mascot.java` row) is scoped to that mascot's character *and keeps the opposite end* — it scans backward from the newest mascot and keeps the first (i.e. newest) one matching `imageSet`, disposing only older matches; non-matching mascots are untouched. Confirmed by reading both loop bodies literally — the asymmetry is real, not a misreading. Both now ported: `Stage.removeAllButOne(matches?)`. |
| `Mascot.java` | 🐛 | `tick()`/`catch (LostGroundException)`, breed/facing plumbing all previously audited and ported. **Missed until Pass 9: `showPopup()` builds a second, complete right-click menu**, separate from the tray's — "Another One!" (this character specifically, not random), "Bye Bye!", "Follow Mouse!", "Reduce to One!", "Restore IE!", a Behaviors submenu, "Bye Everyone!". The last four are shared verbatim with the tray menu *by name*, but "Follow Mouse!" and "Reduce to One!" here call character-scoped overloads (`setBehaviorAll(config, name, imageSet)`, `remainOne(imageSet)`) — genuinely different from the tray's own global ones, not the same feature shown twice. See `Manager.java` row and Pass 9. |
| `Main.java` | 🐛 | **Wrongly written off wholesale as "Java-desktop-only" on the first pass — it isn't.** Its AWT/Swing tray-icon *construction* is out of scope (no Obsidian analog needed), but the menu-item wiring inside it is the real ground truth for how several behaviors actually get triggered. `getManager().setBehaviorAll("ChaseMouse")`, bound to a "Follow Mouse!" tray item, is the *only* way ChaseMouse ever runs in the real engine — no autonomous/spontaneous trigger exists at all. See Pass 5. Read in full in Pass 7 (previously only the tray-menu slice had been read): `createMascot(String)` sets the fresh mascot's anchor to a fixed off-screen point `(-1000,-1000)`, never anything on-screen — it's `UserBehavior.next()`'s off-screen recovery (already ported, see `behavior/UserBehavior.java` row) that actually relocates it, on the mascot's very next tick, to a random x above the screen top and forces Fall. Every real mascot's first visible moment is falling in from off the top of the screen at a random x; there is no separate "appears already standing in view" spawn behavior at all. Our `Stage.spawnMascot` invented one anyway (fixed centered x, fixed y=160) before this file was read in full — fixed, see Pass 7. Also confirmed: the no-arg `createMascot()` random-pack-selection (`(int)(length*Math.random())`) already matches our pre-existing `pickPackId()` exactly — no change needed there. **Pass 5's claim that `remainOne()` "already has a faithful analog in our own 'Remove all Shimejis'" was wrong and went unchecked until Pass 9 — see `Manager.java` row.** **Pass 10: `createMascot(String)` also unconditionally randomizes facing — `mascot.setLookRight(Math.random() < 0.5)` — for *every* fresh top-level mascot, tray or per-mascot "Another One!" alike (both funnel through this exact method, just with a random vs. forced `imageSet`). Missed until directly challenged on it; every manual/auto spawn here had silently always defaulted to facing right. Now ported: `Stage.spawnMascot`'s fresh-spawn path (`spawningFresh`) randomizes `physics.facing` via the same `Random.chance(0.5)` used elsewhere.** |

## Out of scope (⛔ — Java-desktop-only, no Obsidian analog)

Every file below has now actually been opened and read (Pass 7 closed out the last batch that had
only been categorized by name/role — see the changelog). All confirmed harmless: pure Swing/AWT
GUI construction, JNA/OS-native bridging, or logging setup, with no mascot-behavior logic hiding
inside any of them the way `Main.java` turned out to have.

- `exception/*.java` (7 files) — plain `Exception` subclasses, message/cause constructors only, no
  fields, no logic; `LostGroundException` doesn't even have a message constructor, just a bare
  signal type, matching our own `lostGroundFlag` boolean.
- `NativeFactory.java` — reflection-based platform dispatch (`Class.forName(...".win."/".generic."
  + "NativeFactoryImpl")`) to the actual OS-specific `Environment`/native-window implementation.
  That implementation class **is not present anywhere in this source mirror** (sparse-checkout
  only pulls `com/group_finity/mascot/`, and the win/generic subpackages it dispatches to aren't
  under it) — there is genuinely nothing further to read here; this *strengthens* rather than
  weakens the already-documented decision that activeIE/tracked-window tracking is architecturally
  out of scope (`environment/MascotEnvironment.java` row), since the real mechanism isn't just
  "too different to port," it's unavailable to audit against at all in this mirror.
- `LogFormatter.java` — pure `java.util.logging.Formatter` subclass, string formatting only.
- `editor/action/ActionEditorFrame.java` — an empty `JFrame` stub for a *separate* Swing GUI tool
  for authoring packs; our `CharacterEditorModal` is the analog, not a port target.
- `image/NativeImage.java`, `image/TranslucentWindow.java` — bare marker/rendering interfaces, no
  logic.
- `image/ImagePair.java`, `image/ImagePairs.java`, `image/MascotImage.java` — plain data holders
  plus a static load-cache hashtable.
- `image/ImagePairLoader.java` — genuinely worth a note, not just "confirmed harmless": mirroring
  is a **one-time, load-time, per-pixel bitmap flip** (`flip(BufferedImage)`), cached alongside the
  original, with the anchor point recomputed for the flipped image as `width - center.x` (y
  unchanged). Cross-checked this is mathematically equivalent to our own approach in
  `Mascot.ts`'s `render()` (CSS `transform-origin` set to the anchor itself, then `scaleX(-1)`
  around that origin) — both keep the anchor pinned at `(physics.x, physics.y)` regardless of
  facing, just via a baked bitmap vs. a live CSS transform. No code change; a real confirmation,
  not an assumption.
- `imagesetchooser/ImageSetChooser.java`, `imagesetchooser/ImageSetChooserPanel.java`,
  `imagesetchooser/ShimejiList.java` — the startup "which packs to load" Swing dialog (two-column
  `JList` picker + a flat `./ActiveShimeji` config file for persisting the selection) and its
  supporting cell-renderer/panel classes. Our settings UI (`activePackIds`, persisted via
  Obsidian's own settings storage) is the direct functional analog — already existed, already
  correct, nothing to port.
- `menu/JLongMenu.java`, `menu/MenuScroller.java` — Swing popup-positioning and a well-known
  public-domain `JPopupMenu`/`JMenu` scroll utility. Our Obsidian-native context menu is the
  analog; zero mascot-behavior relevance in either (588-line `MenuScroller.java` read in full to
  be sure).

## Bugs found & fixed, by pass

1. **Pass 1** (commit `edcbbad`): pickNextBehavior double-condition bug, missing zero-eligibility
   respawn recovery, missing off-screen recovery, `weightedPick` over-complication, Fall not
   ending on wall contact, Fall not updating facing, Fall's wrong resistance/gravity defaults,
   missing LostGround-equivalent for Move.
2. **Pass 2** (commit `c7195ed`): Look's wrong default (face-cursor → toggle), Jump's wrong
   physics model (ballistic arc → constant-speed vector), Breed's missing BornX sign-flip /
   facing-inheritance / near-end timing, missing LostGround-equivalent for Stay/Animate.
3. **Pass 3** (commit `b73d80e`): `tickHold` rewritten from a linear poseIndex walk to a
   duration-driven, modulo-cycling model — fixes every multi-Pose Stay/Animate action that was
   self-ending after one pass instead of holding/cycling for its real Duration (e.g.
   SitAndDangleLegs: 4 poses ~1.6s combined, held open by a `Duration="500-600"` i.e. 20-24s
   override that was being silently ignored — a ~12-15x undershoot). `ThrowIE` was found mapped
   to plain Fall (wrong — it extends Animate and never touches the mascot's position at all); now
   holds its pose like Regist. This file (`SOURCE_AUDIT.md`) was created in this pass too.
4. **Pass 4** (commit `d46ffe8`): reading `Script.java`/`Variable.java` turned up the real
   `#{...}` (live, re-evaluated every tick) vs `${...}` (evaluated once, cached for the action's
   lifetime) distinction our `Expression.ts` had explicitly (and wrongly) documented as
   "nothing depends on the difference." It matters for Animation-variant selection: real
   `ActionBase.getAnimation()` re-picks the effective (condition-true) variant fresh every tick,
   so a condition depending on live state (e.g. SitAndLookAtMouse's `cursor.y < screen.height/2`,
   held for several hundred ms — long enough for the mouse to cross the threshold mid-hold) can
   swap poses mid-action without restarting it. `chooseAnimation` was only ever called once, at
   push time. Added a `currentPoses()` helper that re-runs it every tick, wired into
   `tickHold`/`tickBreed`/`tickEmbedded`; `tickMove` deliberately keeps its one-time selection
   (see its own comment — no real pack's multi-variant Move needs live re-selection, and
   splicing mid-gait-cycle has no obviously-correct answer). Locals (Duration/TargetX/BornX/...)
   were already correct by construction, since `resolveLocals` already only runs once per
   `pushAction` regardless of which wrapper the XML used.
5. **Pass 5** (commit `1c82883`) — prompted by a direct challenge ("if we've still got
   synthesized code instead of a real port, go rewrite it"): re-examined every remaining
   *invented* (not source-verified) piece of behavior, which turned up exactly one, clearly
   self-flagged in this file's own `script/` table row before this pass: ChaseMouse's "no ground
   truth for its trigger cadence, so this is a periodic-cooldown guess" comment in `BehaviorAI.ts`.
   Went back to `Main.java` — previously written off wholesale as "Java-desktop-only, out of
   scope," which was itself a mistake (see its own row above) — and found the real mechanism:
   `getManager().setBehaviorAll("ChaseMouse")`, bound to a "Follow Mouse!" system-tray item.
   **ChaseMouse has no autonomous trigger in the real engine at all** — it's exclusively a manual,
   all-mascots-at-once command, structurally identical to "Another One!"/"Reduce to One!" (both of
   which we'd already ported faithfully as menu items, which is what made this inconsistency
   worth chasing down). Removed the invented periodic/cooldown eligibility from
   `BehaviorAI.pickNextBehavior` entirely; added the real equivalent — a `followMouseAllMascots()`
   command and context-menu item in `main.ts` that forces every mascot onto ChaseMouse directly,
   the same primitive the existing per-mascot "Set behavior" menu already used. The
   `realPack.test.ts` test that used to assert the invented cooldown fired was inverted (now
   asserts ChaseMouse is *never* autonomously reached) and a new test added for the real
   forced-trigger path.
6. **Pass 6** (2026-08-12, not yet committed as of writing) — closed out the last four `❓` rows
   in this tracker (`config/Entry.java`, `environment/{Area,ComplexArea,Location,Environment}`),
   which turned up the second-largest bug of the whole audit. `Location.java`'s `set()` —
   `dx = (dx + (newX-x)) / 2`, an exponential smoothing of the raw per-tick cursor delta — **is**
   `mascot.environment.cursor.dx/dy`, and the real pack's `Thrown` reads it *directly* as its
   release velocity (`InitialVX="${mascot.environment.cursor.dx}"`). Our `computeReleaseVelocity`
   was an unrelated windowed-average of the *drag's own* recent pointer samples, with a
   `dragThrowScale` tuning constant the real engine has no equivalent of — replaced with a
   faithful `smoothCursorVelocity` port, computed once per fixed simulation tick in
   `Stage.updateAmbientVelocity` (previously this lived only inside `Mascot`'s per-drag pointer
   tracking, sampled independently of the general ambient tracker). Also found, from the same
   file: real `UserBehavior.mouseReleased()` unconditionally forces Thrown — no speed threshold
   at all — while ours branched between "Fall" and "Thrown" by a `minThrowSpeed` comparison;
   `PackDriver.notifyReleased` now always forces "Thrown" (the *native-fallback* placeholder,
   which has no real equivalent to be faithful to, keeps its own simpler two-state distinction).
   Getting this fully correct also required tracking down a **unit-conversion bug this fix would
   otherwise have introduced**: pack-authored per-tick constants (Velocity, Gravity, InitialVX/VY,
   ...) flow through the expression system *unconverted*, only becoming px/second at their one
   specific consumption point (`ActionRunner.applyEmbeddedStartEffects`, pre-existing code) — so
   `cursor.dx/dy` has to stay in the same raw per-tick units for that existing conversion to only
   apply once. `AmbientPointer.dx/dy` now deliberately expose the raw value; `Mascot.finishDrag()`
   (which sets `physics.vx/vy` directly, bypassing the expression system for the native-fallback
   physics) does its own conversion at that point of use instead.
7. **Pass 7** (2026-08-13) — prompted by another direct challenge ("is every file *actually*
   checked, file by file?"): read every remaining file that had only ever been categorized by
   name/role and never opened (`NativeFactory.java`, `LogFormatter.java`,
   `editor/action/ActionEditorFrame.java`, all six `image/*.java` files, all three
   `imagesetchooser/*.java` files, both `menu/*.java` files, and the rest of `Main.java` beyond
   the tray-menu slice Pass 5 had already read). Every one of them confirmed harmless as expected
   *except* the rest of `Main.java`, which turned up this pass's one real bug: `createMascot()`
   creates every new mascot off-screen at a fixed anchor `(-1000,-1000)`; the *actual* on-screen
   spawn position — a random x, dropped in from `screen.top - 256` — comes entirely from
   `UserBehavior.next()`'s off-screen-bounds recovery firing on the mascot's very next tick
   (already ported as `BehaviorAI.respawnAndFall`, from Pass 1/Pass 6-era work — we'd already
   faithfully ported this exact mechanism for the *recovery* case without recognizing it was also
   the *only* real spawn mechanism). There is no real "appears already standing in view" spawn
   behavior at all — every mascot's first visible moment is always falling in from off the top of
   the screen. `Stage.spawnMascot`'s default position (fixed centered x, fixed y=160, "so it's
   fully visible immediately") was an invented UX choice made before this file had been read in
   full. Fixed: a spawn with no explicit position (the command, the "Add another Shimeji" menu
   item, auto-spawn-on-load — every case except Breed/duplicate, which always pass an exact
   parent-relative position) now spawns at a random x across the viewport, `y=-256`, and is born
   directly into "Fall" — exactly mirroring `respawnAndFall`. Also confirmed (no change needed):
   `ImagePairLoader.java`'s load-time bitmap-flip mirroring is mathematically equivalent to our
   CSS-transform-origin approach, and `NativeFactory.java`'s actual platform implementation isn't
   present anywhere in this source mirror, which strengthens rather than weakens the existing
   activeIE-out-of-scope decision. See the "Out of scope" section below for the full per-file
   rundown — every file in the real source tree has now actually been opened and read, not just
   the core simulation subset.
8. **Pass 8** (2026-08-13) — a real feature request, not an audit finding, but landed the same
   way: read the actual `ThrowIE`/`WalkWithIE`/`FallWithIE` source precisely enough to port the
   window-manipulation side effect that Passes prior to this one had correctly identified but
   deliberately left unported ("no analog"). The user was explicit that resizing/popping out a
   real window is worth having if genuinely possible, not to be waved off again — so this time,
   instead of stopping at "no analog," went looking for the closest *real* Obsidian equivalent of
   each: `resizeBy` (WalkWithIE/RunWithIE's "carry the window along while walking," reinterpreted
   as resizing since a pane can't be freely repositioned the way a window can) leans on
   `WorkspaceItem.setDimension`/`WorkspaceSplit.getElSize`, confirmed real (not guessed) by
   reading a published plugin's own source
   ([`obsidian-resize-split`](https://github.com/RyotaUshio/obsidian-resize-split)) that already
   does the same undocumented-API trick. `beginThrow` (ThrowIE's actual window-fling) uses
   `Workspace.moveLeafToPopout` (real, documented) plus repeated `window.moveTo()` on the popout,
   which Electron intentionally lets a renderer drive on its own native window (confirmed against
   Electron's own documented `will-move` interception behavior, not assumed) — the one part of
   this pass that's a genuinely faithful, not reinterpreted, port. Also added `restoreThrown`
   (real `Main.java`'s "Restore IE!" tray item — needed for the first time now that there's
   something to restore) and an entirely new, honestly-not-a-port feature the user asked for
   alongside it: `openRandomNote`, a low-frequency "mischief" swap of the active pane's note,
   which has no real shimeji-ee analog at all (the original has zero vault/file awareness).
   All three gated behind new settings, off by default. See `engine/PaneActions.ts` and
   `ObsidianPaneActions.ts` for the full design reasoning, and the two new entries below this pass
   added to "Open live-bug reports" — the resize/throw mechanisms are the first things in this
   whole audit that couldn't be fully verified by reading source alone and need a live Obsidian
   window to confirm.
9. **Pass 9** (2026-08-13) — prompted directly by "are there other things like pane throwing we
   don't have ported?", asked right after Pass 8 landed. Rather than answer from memory, re-swept
   this file's own remaining hedge language (grepped for "no analog"/"approximated"/"out of
   scope") — that turned up nothing new beyond the two already-accepted multi-monitor exclusions
   — and then checked something the per-file table doesn't naturally cover at all: whether every
   *tray-menu item* actually has a correct, distinct mapping, not just *a* mapping. It didn't:
   `Manager.remainOne()` ("Reduce to One!") had been asserted in Pass 5's own commentary to
   already have "a faithful analog in our own 'Remove all Shimejis'" — never actually checked,
   and wrong. `remainOne()` keeps the *oldest* mascot and disposes the rest; "Remove all
   Shimejis" keeps *none* — a real engine feature had no implementation at all, hiding behind an
   unverified claim that it was already covered. Following that thread further turned up
   something bigger: `Mascot.java` has an entire *second* right-click menu (`showPopup()`,
   distinct from the tray's), previously never read as its own thing. Two of its five items
   share a name with the tray's but call *character-scoped* overloads instead — `remainOne(
   imageSet)` (keeps the *newest* mascot of that character, the opposite end from the no-filter
   version — confirmed by reading both loop bodies, not assumed symmetric) and `setBehaviorAll(
   config, "ChaseMouse", imageSet)` (only that character's mascots join ChaseMouse). This
   plugin's single context menu had been using the *global* semantics for both, since that's
   all "Reduce to One!"/"Follow Mouse!" had ever been checked against. Fixed:
   `Stage.removeAllButOne` now takes an optional filter (implementing both real overloads
   correctly, including the keep-oldest-vs-keep-newest asymmetry), and the context menu's
   versions are rescoped to the clicked mascot's own character (retitled "Reduce this character
   to one"/"Make this character follow the mouse" so the scope is honest at a glance) while the
   command palette keeps the global, tray-equivalent behavior. The real per-mascot "Another One!"
   (this character, but random fall-in position/facing, not offset-from-parent) was *not*
   changed to match exactly at the time — "Duplicate this Shimeji" already covers "spawn the same
   character" reasonably, and the position/facing difference was judged a minor, defensible UX
   choice rather than a missing feature. **Corrected in Pass 10 — see below: asserting that
   without checking whether it was actually safe to diverge was exactly the same mistake as
   Pass 5's unchecked `remainOne()` claim, just made and caught within the same conversation
   instead of across two.**
10. **Pass 10** (2026-08-13) — direct pushback on Pass 9's own closing claim ("do not deliberately
    leave changes against original just like that... is there a proximity-based breeding
    mechanic that would make this matter?"). Checked rather than re-asserted: `Breed.breed()`
    reads only its own mascot's anchor, and there is no mascot-to-mascot distance/proximity
    concept anywhere in the real condition/variable system at all (confirmed by grepping
    `VariableMap`/`Mascot.java`/`Configuration.java` for `getMascots`/`distance`/`nearby` —
    nothing). So breeding specifically isn't proximity-gated — but re-reading `createMascot()`
    carefully enough to answer that turned up a real, separate bug anyway: it also unconditionally
    randomizes facing (`Math.random() < 0.5`) for *every* fresh top-level mascot, a detail that
    had been sitting right there in a method already read and even partially quoted in this file
    since Pass 7, unnoticed until directly asked to re-verify it. Every manual/auto spawn here
    had silently defaulted to facing right always. Fixed: `Stage.spawnMascot`'s fresh-spawn path
    now randomizes facing via `Random.chance(0.5)`. Separately, "Duplicate this Shimeji" was
    replaced with a faithful port of real per-mascot "Another One!" (`spawnAnotherOfCharacter` —
    forces this mascot's character but is otherwise an entirely ordinary fresh spawn: off-screen,
    random facing, not an offset-and-inherit-facing duplicate), retitled "Add another of this
    character" to match. The lesson generalizes beyond this one item: a deviation from the real
    source is only safe to keep once actually checked against what depends on it, not just judged
    "probably fine" — see "Next steps" below.

## Open live-bug reports (need user diagnostics, not more audit)

`window.shimejiDebug` tooling ready (see README) but no repro data gathered yet:

- **Pane resizing** (`ObsidianPaneActions.resizeBy`): built entirely on undocumented internals
  (`WorkspaceItem.dimension`/`.setDimension`, `WorkspaceSplit.getElSize`,
  `Workspace.requestResize`) confirmed only by reading another plugin's source, never run against
  a live Obsidian window from this environment (headless, no GUI — see README's own testing
  caveat). Needs someone to actually enable "Window mischief" and watch a pane resize.
- **Window throwing** (`ObsidianPaneActions.beginThrow`): `moveLeafToPopout` itself is documented
  and should work; whether Obsidian's Electron main process actually *allows* the popout's own
  `window.moveTo()` calls to move it (vs. silently no-op'ing, or intercepting via `will-move`) is
  reasoned from Electron's own general documented behavior, not observed in this specific app.
  Needs a live desktop test to confirm the window actually visibly flies across the screen.

Two older items formerly listed here — "a mascot dropped from a height visually skips most of the
fall" and "drop-to-a-spot lands somewhere else, converging on a few hotspots" — turned out to be
a *real, confirmed* bug (Pass 13's wall-clamp gap: a mascot released near the screen edge with
`y` briefly above worldTop had no horizontal wall protection, so it could drift just past the
edge and trip the *separate* off-screen-recovery safety net, which resets position to a random
spot rather than falling — genuinely no animated fall at all, an instant reset). Pass 12's
ambient-pointer fix (mousemove going stale mid-drag) was real too but turned out not to be what
the user was actually hitting — flagged here so the next reader doesn't assume Pass 12 alone
settled this. Moved out of "open" since there's now a concrete, verified-in-code diagnosis, but
still needs the user's live confirmation like everything DOM-dependent in this file.

## Next steps, in priority order

1. Test/verify/commit/push Pass 10 (this file + Stage.spawnMascot's facing randomization +
   forcedPackId + spawnAnotherOfCharacter).
2. Live-test the Pass 8 "Window mischief" entries in "Open live-bug reports" above — enable it
   in a real desktop Obsidian window and confirm resize and throw both actually do something,
   then report back so this file can move them from "live-bug report" to "confirmed."
3. Re-test the two pre-existing open live-bug reports now that Passes 3-10 have landed.
4. **Every file in the real source tree has now actually been opened and read — not just the
   core simulation subset, the Swing/AWT/JNA GUI files too.** No `❓` rows remain anywhere, and
   the "out of scope" list is no longer split into "opened" vs. "inferred" tiers — it's just
   "opened." What's left is: re-auditing anything a *future* real source update changes, and
   staying skeptical of any comment (ours) that says "no ground truth found," "approximated,"
   "already has a faithful analog" (Pass 9's lesson), or "a minor, defensible UX choice" (Pass
   10's — the same unchecked-assertion mistake, just caught faster the second time), without the
   specific claim ever having been checked. Passes 5, 6, 7, 9, and 10 all came from doubting
   exactly one of these kinds of claims rather than trusting it, and all five turned up real,
   previously-unverified bugs. If another one ever turns up the same way, it's a sign to re-read
   this whole file's own status column with fresh suspicion rather than assume Pass 10 was really
   the last one — and, per Pass 10's own lesson, to treat "I chose not to match the original
   here" as a claim needing its own check, not a stopping point.
5. **Ground truth updated 2026-08-13** (see "Getting the real source" above) — the source tree
   moved from `logany20/shimeji-ee` to `DalekCraft2/Shimeji-Desktop`'s verified Kilkakon
   version-import commits (v1.0.19 through v1.0.22). This was triggered by investigating whether
   real shimeji-ee can "fire a projectile mascot that self-destructs on contact" (it can — via
   Affordances + ScanMove/ScanInteract + BreedMove/BreedJump + Transients + SelfDestruct, none of
   which exist in the old fork). A full feature inventory of everything in the new source newer
   than what's ported was produced and handed to the user as a standalone reference (not
   duplicated into this file) so they can pick what to build next — nothing from it has been
   built yet. Once specific items are chosen, audit and port them the same way as every other
   pass: read the real source at the commits above first, don't infer from the changelog text
   alone.
6. **Pass 11 (2026-08-13): fixed the world ceiling/walls being anchored at the literal top of the
   Electron viewport (y=0) instead of the top of Obsidian's actual usable workspace area.** User
   report: mascots spawning/climbing/ceiling-walking onto the title bar and tab strip (unwanted —
   "you cant see them there") and, separately, that this was blocking the user from dragging or
   resizing the Obsidian window itself. The second half is the same mechanism as the long-open
   "title-bar can't be reliably dragged" report above — the plugin's own ceiling/wall ledges had
   nothing stopping autonomous wall-climbing/ceiling-walking (both authentic shimeji-ee behavior)
   before the true top of the window, so mascots correctly performing that behavior ended up
   rendered on top of, and pointer-event-capturing over, the title bar/tab-header chrome
   underneath. Fixed: `Environment.getWorldTop()` (new) reads `.workspace`'s own bounding rect —
   the element `app.workspace.containerEl` points at, a sibling of the custom title bar and the
   left icon ribbon, not a descendant of either — and `computeLedgesFromRects` now anchors the
   window ceiling and the top of both window walls (plus clamps every pane's own side walls) to
   that instead of a hardcoded 0. This resolves the "spawns/climbs onto the title bar" and (very
   likely — same mechanism, previously unconfirmed for lack of repro data) the "can't drag the
   title bar" reports. Also added `shimejiDebug.dumpLedges()` for future geometry-related reports.
   This pass's own "drop lands somewhere else" speculation (ordinary Fall physics finding a
   different real floor) turned out to be wrong, or at least not the main story — see Pass 12,
   immediately below, which the user's live follow-up made possible to properly root-cause instead
   of guessing at. Needs live confirmation like every DOM-dependent fix in this file (headless dev
   environment, no GUI).
7. **Pass 12 (2026-08-13): fixed the shared ambient cursor tracker going stale for the entire
   duration of every drag, and switched `getWorldTop()` to the real `app.workspace.containerEl`
   API instead of a guessed selector.** User follow-up after live-testing Pass 11: mascots still
   ended up at the top after a reload, and — the more serious finding — dragging a mascot to a
   specific spot and releasing it never showed a fall at all; it instantly relocated to a wildly
   different spot in a single visible frame.
   - **Root cause of the teleport**: `Mascot`'s own `pointerdown` handler calls
     `ev.preventDefault()` (needed so touch-drag doesn't also scroll/select text). Per the Pointer
     Events spec, preventing a `pointerdown`'s default suppresses the *compatibility*
     `mousedown`/`mousemove`/`mouseup` events the browser synthesizes from that pointer for the
     rest of the interaction — real `pointer*` events are unaffected. `Stage`'s shared ambient
     cursor tracker (used for ChaseMouse *and* as a thrown/released mascot's velocity, matching
     the real engine's single `mascot.environment.cursor`) listened for `mousemove`, so it froze
     solid at the grab point for the whole drag. The instant it "unfroze" (the next real mouse
     movement after release), `smoothCursorVelocity` saw one giant single-tick jump instead of the
     drag's true gradual path, and `finishDrag()` baked that bogus jump straight into
     `physics.vx/vy` as release velocity — often large enough to cross the whole window in a
     handful of physics ticks, reading as an instant teleport with no visible fall. This is also
     almost certainly what the older "mascot dropped from a height visually skips most of the
     fall" report (see former "Open live-bug reports" entry, now folded into this one) actually
     was, not a Fall-specific bug. Fixed: `Stage` now listens for `pointermove` at the window
     level instead of `mousemove` — pointer events are never suppressed by another element's own
     `preventDefault()`, unlike the compatibility mouse events derived from them.
   - **Root cause of "still spawns on top" after Pass 11**: unconfirmed, but the likely culprit is
     that Pass 11's `.workspace` CSS selector either didn't match, or matched something with an
     unexpected rect, in the user's actual layout — a guess I had no way to verify without a live
     Obsidian window. Rather than keep guessing at selectors, `Environment`'s constructor now
     optionally takes Obsidian's own `Workspace` object, and `main.ts` passes `this.app.workspace`
     explicitly; `getWorldTop()` reads the real, documented `app.workspace.containerEl` directly
     when available, falling back to the old selector only if nothing was injected. This removes
     the guesswork entirely for real usage; the selector-based path now exists purely as a
     defensive fallback, not the primary mechanism.
   - Needs live confirmation, same as Pass 11 — this environment still has no GUI to test against.
8. **Pass 13 (2026-08-13): found the real cause of the teleport — a gap Pass 11 itself
   introduced — and fixed the "sprite still pokes into the title bar while standing" issue Pass
   12 didn't touch.** User follow-up after live-testing Pass 12: both issues were "absolutely
   the same" as before. Re-reading `BehaviorAI.isOffScreen()`/`respawnAndFall()` (the real
   engine's off-screen recovery, ported in an earlier pass) explained why: it does a *hard*
   position reset — random x, y=-256 — with no animation at all, unrelated to wherever the
   mascot actually was. Working backward from what could trigger it right after a drag release:
   - **Root cause**: Pass 11 clamped the *window's own* left/right wall ledges' `y1` to
     `worldTop`, so autonomous wall-*climbing* would correctly stop there. But `clampToWalls`
     (the unconditional screen-edge safety net — "a hard throw can't send the mascot drifting
     off past the window edge," from an earlier pass) shares that exact same `y1`/`y2` as a
     *containment* check, and now had a gap: a mascot whose `y` was briefly *above* worldTop —
     entirely possible right at a drag release, since `tickDragged` clamps to the raw viewport,
     not worldTop — had no horizontal wall protection at all until gravity pulled it back below
     worldTop. Released right at the edge of the window (matching "top right" in the report)
     with any residual velocity, `physics.x` could drift past the off-screen margin within a
     tick or two — tripping `respawnAndFall()`'s hard, random-position reset, which reads as
     exactly what was reported: no visible fall, an instant relocation to a spot with no
     relation to the release point. Pass 12's ambient-pointer fix was a real, separate bug (and
     stays fixed) but was never the dominant cause here — this is a *location*-triggered bug,
     not a velocity-magnitude one, so it didn't need a large/bogus velocity to reproduce, just
     "released near an edge," which is an entirely ordinary thing to do. Fixed:
     `clampToWalls` now applies window-sourced wall ledges regardless of `y` (only pane-sourced
     walls, and the separate wall-*climbing* detection path, still respect the worldTop-bounded
     range) — see nativeBehaviors.ts's own comment on the function.
   - **Root cause of the residual "still spawns on top"**: separate from the ceiling/wall fixes
     entirely. A pane's own floor can legitimately sit just a few pixels below worldTop — there's
     rarely much room between "top of the workspace" and "top of its topmost pane" — so a mascot
     standing there has a perfectly correct anchor (physics.y never crosses worldTop), but
     floor-standing poses are bottom-anchored, so the sprite's own rendered top edge still
     extends upward from that anchor and pokes above worldTop into the chrome above. Ceiling-hang
     poses don't have this problem (anchored near the sprite's *top*, extending downward). Fixed:
     new `withoutFloorsTooCloseToTop()` (Ledges.ts) excludes any floor within a specific mascot's
     own rendered height of worldTop from the ledges *that mascot* sees each tick (Stage's new
     per-mascot `ledgesFor()`) — it keeps falling past a floor too close to the top instead of
     settling there. Every mascot gets its own cutoff from its own height/scale, so a smaller
     pack isn't excluded from floors a taller one legitimately would be.
   - The honest framing for whoever reads this next: Pass 11 fixed a real bug (ceiling too high)
     while introducing a real regression (wall coverage gap) by sharing one field for two
     different jobs. Nothing here was reproducible without the user's own live testing — three
     rounds of it — which is exactly the discipline this file keeps asking for and exactly why
     guessing from the audit alone kept falling short. Needs live confirmation like everything
     else DOM-dependent in this file.
9. **Pass 14 (2026-08-13): the title bar was still undraggable with zero mascots anywhere near
   it, and the drop still didn't fall — it clung to a wall instead.** Fourth round of live
   testing. Two more real, distinct bugs, neither one about mascot position this time:
   - **Title bar, real cause**: not a mascot at all — the stage overlay's *own* box. `.shimeji-
     stage` is `position:fixed; inset:0`, so it geometrically covers the title-bar region
     regardless of what's positioned inside it, `pointer-events:none` on itself or not. Electron's
     native `-webkit-app-region: drag` hit-testing (what actually makes a custom title bar
     draggable) isn't guaranteed to respect `pointer-events` the way ordinary DOM click dispatch
     does — an overlay merely being *painted* there, even fully transparent and non-interactive by
     normal DOM rules, can still block it. This was already suspected — `shimejiDebug.
     hideOverlay()`/`elementsAtTop()` were built for exactly this back in an earlier pass — but
     never confirmed until mascots stopped being the more obvious, competing explanation. Fixed:
     `Stage`'s container now sets `clip-path: inset(${worldTop}px 0 0 0)`, recomputed alongside the
     ledges — this removes the title-bar region from the element's box entirely (painting *and*
     hit-testing) without touching `top`/`left`, so it doesn't shift the coordinate origin
     `translate3d`-positioned mascots are anchored against.
   - **The drop, real cause**: `clampToWalls` can pin `physics.x` exactly onto *any* wall's x
     (window or pane) and zeroes `vx` when it does; `applyGravityAndLand`'s own wall-catch check
     (`findClingableWall`, reach 0.5) ran immediately after, on the very same tick — so a position
     `clampToWalls` had just corrected always satisfied it, collapsing "prevented from escaping"
     and "genuinely flew into a wall" into the same event. A drag release near any wall (not just
     the screen edge — Pass 13 only fixed the screen-edge escape case, not this) starts `physics.x`
     already pinned there from `tickDragged`'s own clamp, so the very first falling tick "caught" a
     wall it was never actually flying into — zero visible fall. Fixed the same way `findFloorBelow`
     already handles its own version of this (pre-step position, not post-step): capture whether
     the mascot was *already* within wall-catch reach *before* this tick's own movement; only treat
     it as a genuine catch if this tick's own motion is what brought it into reach. A mascot
     starting pinned at a wall now keeps falling under gravity (still x-clamped, but free to
     integrate `vy`) until it reaches a real floor; a mascot that genuinely flies into a wall from
     farther away — including fast enough to need clamping on the arrival tick itself — still
     catches correctly, so this doesn't reopen the original "falling into the side of a pane just
     clamped and kept going" bug an earlier pass fixed.
   - Both bugs were invisible to static reading alone (everything downstream of the actual state
     looked individually correct) and only became findable by working backward from precise,
     literal descriptions of what was observed — "still can't interact with the top bar" with no
     mascot in sight ruled out every mascot-position theory at once; "mostly snaps to wall" pointed
     directly at `findClingableWall` once taken literally instead of folded into the same bucket as
     the earlier random-teleport bug. Needs live confirmation, same as every DOM/physics fix in
     this file — this environment still has no GUI.
10. **Pass 15 (2026-08-13): confirmed, not speculative — a real `Math.random` typo in actual pack
    XML, breaking randomization silently.** User reported Passes 13-14 produced *zero* observed
    change (title bar still blocked, drop still not falling right), verified they were actually
    pulling and reloading correctly (a `git pull` transcript confirmed it), and posted a DevTools
    console warning: `unsupported expression identifier "Math.random"; defaulting to
    false/undefined`, firing continuously inside the simulation loop.
    - Reading `Shimeji/conf/actions.xml` (this plugin's own bundled reference pack) for
      `Math.random` found the exact cause at lines 443 and 533 (`ClimbCeiling`/`Walk`'s own
      `TargetX`): `mascot.lookRight ? workArea.left+Math.random()*100 :
      workArea.right-Math.random*100` — the second half of that ternary is missing the call
      parens the first half has. A bare `Math.random` (no `()`) parses as a plain property *path*,
      not a *call* — `RuntimeContext.resolve()` only recognized `mascot.*`/`environment.*` paths,
      so this fell through its generic "unknown identifier" branch, warned, and returned
      `undefined` — which arithmetic then silently turns into `0`. The randomized "walk to
      somewhere within 100px of the edge" became "walk to *exactly* the edge, every single time,"
      deterministically, whenever facing that direction — invisible as a bug in isolation, but the
      likely explanation for the "walks to the edge, then respawns at start of line" pattern the
      user found reproduced identically across multiple replications, and for at least some of the
      broader sense that behavior wasn't varying the way it should.
    - Fixed: `resolve()` now special-cases a bare `Math.random` (still nothing else in that
      family — `.min`/`.max`/`.abs`/`.floor` all require arguments a bare reference can't supply
      sensibly) to the same `rng.range(0, 1)` the real call already used, rather than defaulting
      to a silently-wrong constant. This is a real, ported-content bug fix, not a new invention —
      confirmed present in *our own bundled reference copy* of the pack, independent of whatever
      third-party pack the user was actually testing with, so it isn't specific to their pack.
    - Deliberately scoped narrow: this pass does **not** touch the title-bar or wall-catch fixes
      from Passes 13-14, which the user reports still show no effect. Given confirmation that
      reloading *is* working correctly, that needs its own fresh diagnosis rather than being
      bundled with an unrelated, independently-confirmed fix — see "Open live-bug reports" below.

## Open, actively-suspicious items

- **Wall-catch-on-release**: the `alreadyAtWall` fix (Pass 14) is unit-tested and the logic traces
  through cleanly by hand, but the user's live result (as of the Pass 13/14 round) contradicted it
  just as flatly as the title bar did. Turned out `debugLog` itself was silently broken (see Pass
  16) — `setVerbose(true)` produced zero visible output for a live repro, meaning no verbose trace
  has actually been collected against this specific symptom yet. Needs a fresh drag-release repro
  with verbose logging now that the logger itself works, before concluding anything either way.

11. **Pass 16 (2026-08-13): the title-bar theory from Pass 15 was confirmed with live data, not
    just plausible — and verbose logging turned out to have been silently producing zero output
    the entire time.**
    - **Title bar, confirmed and fixed**: `document.querySelector('.workspace').getBoundingClientRect().top`
      came back `0` from the user's own console — confirming Pass 15's theory exactly.
      `shimejiDebug.elementsAtTop(15)` then found the real drag-region element directly:
      `.workspace-tab-header-spacer` (inside a `.workspace-tab-header-container`), computed
      `-webkit-app-region: drag` — genuinely exposed at the window's horizontal center, meaning
      the overlay was never blocking *that* point at all. A final check
      (`.workspace-tab-header-spacer`'s parent) gave the real, confirmed number: that container
      spans `y: [0, 40]` — a real, nonzero row height that `.workspace.containerEl`'s own position
      (stuck at 0 in this "tabs merged into the title bar" layout) can never see. `getWorldTop()`
      now takes `Math.max()` of two independent signals: `workspace.containerEl`'s own top (right
      for a separate-title-bar layout) and the bottom edge of the *topmost* row of
      `.workspace-tab-header-container` elements (right for the merged layout this user actually
      has) — restricted to the topmost row specifically so a vertically-split layout's other, lower
      pane groups (which have their own tab-header-container too, unrelated to the title bar)
      don't get pulled in.
    - **Verbose logging was silently broken**: `debugLog()` used `console.debug()`, which
      Chromium's DevTools console categorizes as "Verbose" and hides under the default "Default
      levels" filter shown in the user's own screenshots throughout this investigation — so
      `setVerbose(true)` had very likely been firing correctly the entire time, just never visibly,
      for every verbose-logging request made across this whole bug-fixing arc. Switched to
      `console.info()`. Also gave `forceBehavior()` (the drag-release/"jump to a named behavior"
      path) its own log line — it was the one path that never logged at all, `startBehavior()`
      being the only method with a debugLog call, so a verbose trace across a drag release used to
      omit the single most relevant line even once the console-level issue is fixed.
    - Both fixes are a direct product of insisting on real console output over reasoning from DOM
      structure alone — the same discipline the user was (rightly, if bluntly) demanding after
      Passes 13-14 landed and did nothing. Needs live confirmation like everything else in this
      file, but this time from data, not a theory about Obsidian's DOM.

12. **Pass 17 (2026-08-13): found the actual teleport bug — from the user's own verbose log, after
    four earlier passes guessed wrong at the same symptom.** The log line that broke it open:
    three independent releases (from x=759, x=978, and a respawn at x=492) all reported
    `landed on a wall while falling {x: 482.16668701171875}` — the *same* coordinate to 14 decimal
    places, reached in a single tick. Identical output from different inputs is a snap, not physics.
    - **Root cause**: `clampToWalls` computed `minX = max(all left walls)` / `maxX = min(all right
      walls)` over *every* wall ledge, pane sides included. That's only meaningful for walls that
      genuinely bound the world. In an ordinary side-by-side Obsidian layout, a pane boundary sits
      partway across the screen, so `maxX` collapsed to that x **for every mascot in the window** —
      including ones far to its right with nothing in their way. A mascot released anywhere right
      of that boundary was yanked onto it on its first falling tick, `vx` zeroed, then immediately
      "caught" the wall it had just been teleported onto. That is precisely "he just teleports,
      mostly snaps to wall, no fall line traced." Fixed: only *window*-sourced walls act as
      position clamps.
    - **Why four passes missed it**: every earlier attempt (worldTop, `alreadyAtWall`, ambient
      pointer, off-screen recovery) targeted the *window* edges and the top of the screen. The
      actual culprit was a pane boundary in the *middle* of the screen, and nothing in those
      theories could have touched it. Passes 12-14 shipped, were logically sound, and changed
      nothing observable — the user said so plainly each time and was right each time.
    - **Not a regression**: pane walls were still needed to *catch* a mascot that genuinely flies
      into one (real packs' GrabIEBottomLeftWall etc. depend on it), which the old global clamp
      supplied as a side effect. Replaced with `findCrossedWall()` — a proper swept test that fires
      only when this tick's own movement actually carried the mascot through that wall's x within
      its real y-span. Catches correctly, never acts at a distance, and doesn't tunnel at speed.
    - **Also**: the stage overlay now offsets its own `top` to worldTop rather than using
      `clip-path` (which leaves the layout box in place and demonstrably changed nothing for the
      title bar). `Mascot.render()` subtracts worldTop at the one point a physics coordinate
      becomes a DOM offset; physics stays viewport-space everywhere else. The `getWorldTop` dep was
      also found *unwired* in `Stage.createMascot` — it would have silently defaulted to 0 and made
      the whole offset a no-op, the same class of silent-no-op that made Pass 14 useless.
      **Still unconfirmed against a live window**; `shimejiDebug.hideOverlay()` remains the test
      that would actually prove whether the overlay is the title-bar cause at all.
    - Verified end-to-end by replaying the user's exact logged release (x=978, y=435, vx=31,
      vy=-121) through the real integrator: a 30-tick arc that rises, turns over, accelerates down
      and lands on the actual floor — instead of one tick to x=482.

13. **Pass 18 (2026-08-13): two remaining bugs from a live trace — both traced to real source.**
    User confirmed Pass 17 fixed the title bar and most drops, leaving: (a) a mascot that climbs a
    wall to the top can't transfer onto the ceiling and just falls, (b) drops still teleport when a
    pane is split *horizontally*.
    - **(b) root cause — the integrator wasn't sweeping.** Read real `Fall.tick()`: it does *not*
      apply a tick's movement in one jump. It computes `dev = max(1, max(|dx|, |dy|))` and walks
      the path in ~1px substeps (`x = anchorX + dx * i / dev`), testing floor and wall at *each*
      substep and stopping exactly where contact happens. Ours applied the whole move at once and
      looked the floor up at the **pre-step x**, then applied it after the mascot had already moved
      elsewhere. With a horizontal split (panes stacked at different heights) a fast mascot landed
      on the floor that was under its *old* position, at an x where that floor doesn't exist —
      a sideways jump. It also tunnelled through anything thinner than one tick of travel. Ported
      the substepped sweep; floor and wall contact now agree because both are evaluated against the
      same point on the same path. Verified: a 9000px/s drop now catches a pane top at y=900
      instead of falling through to y=2000, and the horizontal-split case lands on a floor that
      genuinely spans its final x.
    - **(a) root cause — the pack was asking about a ceiling that had moved.** `worldTop` (Pass 16)
      moved the real ceiling ledge to below the tab strip, but `RuntimeContext` still answered
      `mascot.environment.ceiling.isOn(...)` with `y <= 4` and `workArea.top` with a hardcoded `0`.
      So the pack's own `HoldOntoCeiling`/`ClimbAlongCeiling` conditions could never be true at the
      real ceiling line (y=40 in this user's layout), and its climb targets
      (`workArea.top+64`, `workArea.top+64 + Math.random()*(workArea.height-128)`) aimed 40px into
      the chrome. The mascot climbed, was told it wasn't on the ceiling, and fell — exactly the
      report. `worldTop` is now threaded into `RuntimeEnv` and used for `ceiling.isOn`,
      `workArea.topBorder.isOn`, `workArea.top` and `workArea.height`.
    - Lesson worth keeping: (a) is a *second-order* bug created by Pass 16's own fix — moving the
      world's ceiling without moving what the pack is told about it. Any future change to the
      world's geometry has to update `RuntimeContext`'s answers in the same commit, or packs will
      keep silently disagreeing with the physics.

14. **Pass 19 (2026-08-13): the last teleport — a coincident-edge tie-break picking the wrong wall
    face.** User confirmed Pass 18 fixed the ceiling transfer (`ClimbAlongWall {y: 1328}` →
    `ClimbAlongCeiling {x: 1977, y: 40}` in the trace) and most drops, leaving one residual
    teleport. Its signature in the log was unmistakable and *different* from every earlier one:
    `landed on a wall ... side: 'right', source: 'pane'` immediately followed by
    `respawn (nothing eligible, or drifted off-screen)` — so the mascot was catching the wall
    correctly and then being teleported by the respawn safety net a tick later.
    - **Root cause**: adjacent panes share an edge, so a split workspace has *two* wall ledges at
      the exact same x — the left pane's right face and the right pane's left face. Both
      `updateWallCeilingAdherence` and `findClingableWall` broke that tie with a fixed
      left-before-right order. A mascot flying leftward correctly caught the right-hand face, then
      the very next tick's adherence pass silently reassigned it to the coincident *left*-hand one.
      The pack decides what a wall-hanging mascot may do next with
      `mascot.lookRight ? activeIE.leftBorder.isOn(...) : activeIE.rightBorder.isOn(...)` — with the
      side flipped, that condition went false, **nothing** was eligible, `totalWeight <= 0` fired,
      and `respawnAndFall()` threw the mascot to a random x above the screen. Exactly the observed
      "still teleports when a pane is divided" case, and only in split layouts, because only a split
      creates a shared edge.
    - **Fixes**: (1) `keepOrFindWall` — stay attached to the wall already held as long as the mascot
      is genuinely still against it (matched by value; Stage rebuilds ledge objects periodically),
      mirroring how a real `BorderedAction` holds one `getBorder()` for its whole run instead of
      re-deciding each tick. (2) At a genuine tie, pick the face *opposing* the direction of travel
      — moving left you strike a right-hand face, moving right a left-hand face — applied in
      `findCrossedWall`, in the post-sweep proximity catch, and (biased by facing) in the
      adherence fallback for a mascot that simply walked into a wall with no prior attachment.
    - Worth noting for anyone reading this later: the sweep from Pass 18 often finishes a fraction
      of a pixel *short* of a wall rather than strictly crossing it, so the post-loop proximity
      check is what actually catches most contacts — it needed the same tie-break, and fixing only
      `findCrossedWall` would have looked correct in isolation while changing nothing in practice.

15. **Pass 20 (2026-08-13): the horizontal-split teleport — `clampToCeiling` had the identical
    defect `clampToWalls` did, and it was missed when that one was fixed.** User: "horizontal panes
    still break it." The log's tell was two different throws (from x=1098 vx=-1469, and x=1030
    vx=-2429) reporting *identical* final coordinates to 14 decimal places —
    `482.16668701171875, 1349.3333740234375`. Different trajectories cannot produce the same y;
    that's a snap, and the y in question is a pane divider.
    - **Root cause**: `clampToCeiling` took `max(y)` over **every** ceiling ledge spanning the
      mascot's x — and a pane's underside is a ceiling ledge. A horizontal split puts a pane bottom
      edge partway *down* the screen, so it became the world's ceiling for everything above it: a
      mascot thrown *upward* from below was slammed straight down onto that line and had its upward
      velocity zeroed in a single tick. Reproduced exactly before changing anything: tick 0 of the
      logged throw moved y from 1043 to 1349.33 despite `vy = -2254` (upward). Fixed the same way
      Pass 17 fixed its sibling — window-sourced ceilings only. Pane undersides remain fully usable
      for detection and ceiling-hanging (`findCeilingAt`/`updateWallCeilingAdherence`, untouched).
    - **Process note, and the real lesson of this pass**: Pass 17 diagnosed precisely this failure
      mode ("an extreme over every ledge of a kind, including pane-sourced ones, is only meaningful
      for ledges that genuinely bound the world") and fixed it in `clampToWalls` — while the
      function directly beneath it, written from the same template and with a comment literally
      beginning "Same idea as clampToWalls", had the same defect and was never looked at. When a
      bug is found in one function, the sibling built from the same pattern must be checked in the
      same pass; several rounds of user testing were spent on what one grep would have caught.
    - Verified by replaying both logged throws: they now trace 10- and 5-tick arcs that genuinely
      rise as thrown and end at *different* positions, instead of collapsing onto one shared
      divider coordinate.

## Feature port: the v1.0.13-v1.0.18 "Recommended" set (2026-08-13)

First batch of features from the new ground truth (see the feature inventory handed to the user).
All seven read from the real source at `DalekCraft2/Shimeji-Desktop` before implementing, per the
golden rule at the top of this file.

16. **Affordances (v1.0.14)** — `Mascot.affordances` (a live `List<String>`), rewritten by
    `ActionBase.tick()` at the top of *every* tick: clear, then re-add this action's own
    `Affordance` attribute. It describes what a mascot is offering *right now*, never accumulated
    history. `Stage.getMascotWithAffordance()` ports `Manager.getMascotWithAffordance(String)` —
    a linear scan in list order, so with several candidates the earliest-created wins and pairing
    is deterministic rather than flickering tick to tick.
17. **ScanMove (v1.0.14)** — resolves its target *once* in `init()` (ScanInteract is the variant
    that re-scans; not ported in this batch), then tracks that mascot's live anchor every tick,
    turns to face it, and moves toward it. On arrival it sets `Behaviour` on itself and
    `TargetBehaviour` on the target **in the same instant**, with `TargetLook` turning the target
    to face back. Ends early if the target stops broadcasting (real `hasNext()`). "Contact" is
    arrival at tracked coordinates — there is no bounding-box collision between mascots anywhere
    in the real engine, in any version.
18. **BreedMove / BreedJump (v1.0.18)** — ordinary Move/Jump that additionally call the shared
    `Breed.Delegate` on an interval frame (`getTime() % BornInterval == 0`) for as long as they
    run: "fire repeatedly while moving", versus plain Breed's single spawn at the end of a birth
    animation. Uses the same delegate for all three, as the original does.
19. **BornMascot / BornTransient / BornCount / BornInterval** — the full `Breed.Delegate`
    parameter set. `BornMascot` spawns a *different character*, with the real fallback to the
    parent's own image set when no pack by that name exists (an unknown name means "same character
    as me", never an error). `BornTransient` gates on a **separate** `transients` setting rather
    than `breeding` — both real, both now exposed — so a pack can fire disposable effect-clones
    without the user enabling full self-replication. `BornCount` spawns N per event.
    Also fixed while here: Breed's parameters were being read with a bare `parseFloat`, so any
    expression-valued `BornX`/`BornY` silently became 0. All action parameters now go through the
    expression evaluator, which is what real `ActionBase.eval` does for every one of them.
20. **SelfDestruct (v1.0.13)** — plays its animation once, then disposes. Purely time-based; there
    is no collision test in it in any version. "Self-destructs on contact" is achieved by whatever
    *sets* this behavior (a Scan action's arrival), never by SelfDestruct sensing anything. Note it
    `extends Animate`, so it inherits Animate's one-cycle cap — our `tickHold` didn't know that and
    held the final pose forever without ever firing, caught by the test that asserts it never
    disposes early *and* does eventually dispose.
21. **DismissAllOthers (v1.0.17)** — and, found while reading `Mascot.showPopup` for it, a real
    divergence in the *existing* port: both per-mascot menu items pass the clicked mascot
    (`remainOne(imageSet, this)` / `remainOne(this)`), so they keep **that** mascot. The earlier
    port had read only the unparameterised overloads and kept "the newest of that character"
    instead — clicking one mascot could leave a different one alive. Corrected, and the two
    genuinely different per-mascot items are now both present ("Dismiss others of this character"
    and "Dismiss all other Shimejis"), alongside the tray-level oldest-survives command.

Not in this batch (from the same inventory, all "Worth doing" rather than "Recommended"):
ScanInteract, ScanJump, Interact, Draggable, Hotspot, Toggleable, Shimeji Variables, exposed
physics variables, type-specific Count, and the whole Sound subsystem.

## Feature port: the "Worth doing" set, part 1 (2026-08-13)

22. **ScanInteract (v1.0.21)** — the stationary counterpart to ScanMove. Three differences from it,
    all load-bearing: it **re-scans every tick** (rather than locking onto one target at init), it
    never moves (plays its animation in place, only turning to face), and it fires on its
    animation's **last frame** rather than on arrival — and only when `Behaviour` is actually set.
23. **Per-action Draggable (v1.0.13)** — `ActionBase.isDraggable()`, default true, consulted by
    UserBehavior on mouse-down as `handled = !actionBase.isDraggable()`: a non-draggable action
    swallows the grab entirely. Reported from the innermost running frame (the action actually in
    effect) and checked in Mascot's own pointerdown, *after* the app-level "allow dragging" toggle —
    the two are independent, and the pack-level one is the finer-grained of the pair.
24. **Exposed physics variables (v1.0.21)** — real Fall/Jump both `putVariable(VELOCITYX/Y)` every
    tick; ScanMove publishes `TargetX`/`TargetY` the same way. Written into the frame's own locals,
    which is exactly the scope an action's Animation conditions read, so `#{VelocityY > 20}` works
    from inside the action producing it. Published in per-tick pixel units, matching every other
    pack-authored quantity rather than our internal px/second.
25. **Type-specific Count (v1.0.16)** — `Mascot.getCount()` → `Manager.getCount(imageSet)` is
    scoped to the mascot's own character, distinct from `getTotalCount()`. Only the Obsidian layer
    knows which pack each mascot wears, so the counter is supplied from there and falls back to the
    total when unavailable.
26. **Toggleable behaviors (v1.0.21)** — a `Toggleable` attribute making a behavior persistently
    switchable from the mascot's own menu, distinct from the existing one-shot "run this now".
    Faithful defaulting from real BehaviorBuilder: an **absent** attribute means *not* toggleable,
    and ChaseMouse/Fall/Thrown/Dragged are force-excluded regardless of what the XML says — letting
    a user switch off Fall would break the mascot rather than customise it. Disabling excludes a
    behavior from *autonomous* selection only (both the general pool and NextBehavior edges);
    forcing one by name still works, as the real "set behavior" item does. Choices persist per pack
    and apply to every mascot of that character, matching real `Main.setMascotBehaviorEnabled`.

## Feature port: the "Worth doing" set, part 2 (2026-08-14)

The three that were still outstanding after part 1. With these the whole inventory — both
"Recommended" and "Worth doing" — is ported.

27. **Hotspot (v1.0.19)** — `animation/Hotspot.java`, a clickable region declared per-`<Animation>`
    that runs a named behavior instead of starting a drag. Hotspots are **refreshed every tick**
    from the *currently effective* Animation (real `ActionBase.refreshHotspots()`), so which regions
    are live follows whichever condition-gated variant is selected right now, not whichever one was
    selected when the action started; and the x coordinate is **mirrored when the mascot faces
    right** (`mascot.isLookRight() ? bounds.width - point.x : point.x`), so a pack authors a hotspot
    once against the unflipped art.

    ⚠️ **Shipped wrong first, corrected in pass 22 — see entry 30.** The initial port read
    `Hotspot.java` in isolation and concluded a hit consumes the click even with a null `Behaviour`.
    It does not, in the current source: `UserBehavior.mousePressed` ANDs
    `configuration.isBehaviorEnabled(hotspot.getBehaviour(), mascot)` into the *match* itself, and
    the `String` overload of that method returns `false` for any name absent from
    `behaviorBuilders` — `null` included. That reading was correct for v1.0.19-v1.0.20, before
    v1.0.21 added the conjunct.
28. **Shimeji Variables (v1.0.22)** — `mascot.getVariables()`, a `Map<String, Object>` the engine
    itself never reads ("not accessed by the program itself" in the source's own words), existing
    purely so a pack can keep arbitrary per-mascot state across actions and behaviors for the
    mascot's whole life. Reaching it needs bracket indexing and assignment in the expression
    language, neither of which the evaluator had: added `index`/`assign` node kinds, a `=` token
    (registered after the multi-char operators so `==` still wins the tokenizer), and
    `parseAssignment` at the lowest precedence, right-associative. Only `mascot.variables[...]` is
    writable — every other path in the context is derived state a pack must not be able to poke.
    Reading an unset variable yields undefined without a warning, since testing a variable before
    ever assigning it is a legitimate pack idiom.
29. **Sound (v1.0.9 / v1.0.16)** — a per-`<Pose>` `Sound` file with an optional `Volume`, plus the
    `Mute` action. The subsystem's real shape, all of which matters:
    - `Pose.apply()` ends with `mascot.setSound(soundKey)` — run **every tick the pose is
      active**, not once when it starts. What keeps that from machine-gunning the clip is the
      guard on the other side, in `Mascot.apply()`: `if (!clip.isRunning()) { clip.stop();
      clip.setMicrosecondPosition(0); clip.start(); }`. Porting only the first half would have
      retriggered a sound ~25×/second for a pose held one second.
    - `Sounds.load` keys a clip by **`fileName + ':' + volume`**, so one file declared at two
      volumes is genuinely two clips with two independent "is it running" answers, and they can
      overlap. `SoundPlayer` keys the same way rather than by file alone.
    - `Mute` (`extends InstantAction` — `hasNext()` is hardcoded false, so it completes on the tick
      it starts, never held for its animation's duration) uses `Sounds.getAllByFile`, which returns
      **every volume variant** of a path — hence the `keysByFile` index. Note the original's own
      asymmetry, kept deliberately: the named-file branch runs regardless of the sound setting,
      while the stop-everything branch is gated on `Sounds.isEnabled()`.
    - `Volume` is a Java `FloatControl` MASTER_GAIN value in **decibels**, defaulting to 0 (=
      unchanged), not a 0-1 fraction. `HTMLAudioElement.volume` is linear, so it is converted as
      `10^(dB/20)` and clamped. Reading `Volume="-10"` as "10% volume" would have been silently,
      unfixably wrong for every pack that ships sound.
    - Sound file lookup follows real `Main.getSoundFilePath`'s three candidate directories in
      order (`img/<set>/sound/`, `sound/<set>/`, `sound/`). The original resolves these eagerly at
      parse time; so does `PackLoader`, because vault-adapter existence checks are async and pose
      display is not.
    - The clip registry is a module-level singleton because real `Sounds` is a static class, and
      "is this clip already running" is only a meaningful question if every mascot shares one
      registry. It is explicitly torn down in `onunload` — a singleton outlives the plugin
      instance, so a disable/enable cycle would otherwise leave the previous load's clips playing.

    One deliberate divergence: sound is **off by default** here, where the original defaults it on.
    A note-taking app making noise unprompted is a different proposition from a mascot app you
    launched specifically to be a mascot. There is also a master-volume slider, which the original
    has as a global setting too; it scales each clip on top of the pack's own authored `Volume`
    rather than replacing it.

## Pass 22: the hotspot click path (2026-08-14)

Three bugs in the Hotspot port from the previous commit, all in `Mascot`'s `pointerdown`, all found
by re-reading `UserBehavior.mousePressed` line by line rather than trusting the summary of it. Root
cause of all three is the same: the port was built from `animation/Hotspot.java` (the geometry) plus
a remembered paraphrase of the call site, instead of from the call site itself.

The real predicate is a **conjunction**, evaluated inside the loop, before the `break`:

```java
if (hotspot.contains(mascot, event.getPoint()) &&
        Main.getInstance().getConfiguration(mascot.getImageSet()).isBehaviorEnabled(hotspot.getBehaviour(), mascot)) {
    handled = true;
    ...
    break;
}
```

30. **Hotspots were dead whenever "Allow dragging" was off.** The scan sat *below* this file's own
    `if (!this.dragEnabled) return;` early-return. The real engine has no app-level dragging toggle
    at all, and checks hotspots before anything drag-related — a hotspot is a click target, not a
    grab, so the setting has no business gating it. Moved above the check.
31. **A hotspot whose behavior the user had switched off still fired.** The `isBehaviorEnabled`
    conjunct was missing entirely, so the `Toggleable` mechanism ported one commit earlier (entry 26)
    was silently bypassed on this path. Because the check is *inside* the loop rather than after it,
    getting this right also means a disabled hotspot is **transparent** — it doesn't consume the
    click, and the scan continues to the next overlapping hotspot, falling through to the drag path
    if nothing else matches. Both properties are now pinned by tests.
32. **A hotspot with no `Behaviour` wrongly swallowed the click** (and so did one naming a behavior
    the pack never defines). See the correction on entry 27: the `String` overload of
    `isBehaviorEnabled` is a "known *and* available" test — `behaviorBuilders.containsKey(name)`
    else `false` — and `behaviorBuilders` is a `LinkedHashMap`, so a `null` lookup returns false
    cleanly rather than throwing. Such a hotspot is therefore transparent.

Also ported for these: `Configuration.isBehaviorEnabled(String, Mascot)` itself, on `BehaviorAI`/
`PackDriver`. It is *not* simply `!disabled.has(name)` — a behavior that isn't `Toggleable` is
always enabled regardless of the disabled list, and an unknown name is false rather than true.

**Process note, and the actual lesson.** These bugs shipped in a commit whose suite was green at 235
tests, because the hotspot *click path had no test at all* — only the parser and the per-tick
refresh were covered. The feature was reported complete on the strength of coverage that never
touched its main behavior. Before claiming a user-facing interaction is ported, there must be a test
that exercises *that interaction*, not just the data it reads. All five of the new tests were
confirmed red against the previous commit's `Mascot.ts` before being accepted — the same
revert-and-verify step that Passes 12-14 established after three consecutive no-op "fixes", now
applied to feature work rather than only to bug reports.

## Invented: grab-by-the-feet upside-down dragging (2026-08-14)

Requested directly by the user ("drag it by head but also drag it by feet which drags it upside
down"), so it goes in the same category as note mischief and the pane-throwing reinterpretation: an
addition, clearly labelled, not a port. Recorded here because half of it *is* a real mechanism that
had gone unnoticed until now.

**What's real.** `Dragged.java` has `OffsetX` / `OffsetY` / `OffsetType` parameters
(`DEFAULT_OFFSETY = 120`) and sets the anchor to `cursor + offset` on every tick. So "which part of
itself the mascot hangs by" is already an authorable quantity in the original, and grabbing it
somewhere else is simply a different offset. With the standard pack's `ImageAnchor="64,128"` on a
128px-tall sprite, the real default of 120 places the cursor 8px below the top of the frame — the
mascot is pinched by the head, which is what the Pinched artwork is drawn for. `DRAG_ANCHOR_OFFSET_Y`
was already ported correctly (Pass 8); what was missing was noticing that it is a *parameter*, and
what it implies.

**What's invented.** The vertical flip. `grep -rn 'upsideDown\|flipVertical\|scaleY\|rotate'` over
the whole package returns nothing — `setLookRight` mirrors horizontally and that is the only
orientation the engine has. Grabbing the feet therefore uses offset 0 (soles at the cursor) plus a
`scaleY(-1)` so the body hangs *below* the pinch instead of standing above it.

Implementation notes worth keeping:

- The flip is one inner-element transform, not an adjustment to the computed `top`. `render()`
  already sets `transformOrigin` to the anchor point, so `scaleY(-1)` mirrors about the anchor *row*
  — the grabbed point stays exactly under the cursor and only the body swings across it. No
  repositioning needed.
- Orientation is decided **once, at the grab**, and held for the whole drag. Real `Dragged` re-reads
  its offsets every tick, but there they are pack constants; here the value comes from where the
  pointer landed, and a mascot that flipped mid-drag because the cursor drifted would be nonsense.
- Cleared in `finishDrag()`. Everything after release — Thrown, Falling, landing — is upright art,
  so the flip must not outlive the grab. `render()` additionally guards on `isDraggedUpsideDown`
  (which requires `isDragging`) rather than the raw flag, so a grab that aborts between setting the
  orientation and starting the drag can't leave a standing mascot on its head.
- It runs strictly *after* the real hotspot scan declines the click, so pack-authored `<Hotspot>`
  regions keep absolute priority. Pinned by a test.

**Why not a `<Hotspot>`, given that is what was asked for.** A real Hotspot *replaces* the drag
rather than starting one — `handled = true` and the drag never begins — so it structurally cannot
express "pick me up, but differently". It is also declared per-`<Animation>`, so an always-available
feet region would have to be duplicated onto every action in the pack and would still be inert. The
grab region is a property of the grab, so it lives on the grab path; the reference
`Shimeji/conf/actions.xml` stays untouched, as it has throughout.

## Investigated: "follow mouse only sits there" — not a bug (2026-08-14)

User report: after "follow the mouse", the mascot sits down within a few ticks and then only turns
to face the pointer, never chasing it.

**Verdict: that is the faithful behavior, reproduced correctly.** Traced through the real standard
pack with a shared RNG (see the process note below) at three geometries:

| scenario | result |
| --- | --- |
| bare window, cursor 800px away | 782px travelled over ~101 ticks, then SitAndFaceMouse |
| bare window, cursor 60px away | 59px travelled over 11 ticks, then SitAndFaceMouse forever |
| standing on a pane top, cursor far | dashes to the pane's left edge, jumps off, falls, bounces, *then* starts the Dash chain |

The chain is a deliberate cul-de-sac in the pack. `Manager.setBehaviorAll(config, name, imageSet)`
is a single `mascot.setBehavior(...)` per mascot — verified in Manager.java, no loop, no mode flag —
and from there the pack drives itself: ChaseMouse -> (`Add="false"`) SitAndFaceMouse ->
(`Add="false"`) *itself* at `Frequency="100"`. So one dash, then sit and watch, indefinitely. Real
ChaseMouse also only ever targets the pointer's **x**; it never climbs toward its y.

The user's observation is the second row: their pointer was horizontally near the mascot, so all
three of ChaseMouse's randomised Dash steps had almost no ground to cover. Nothing to fix.

**Added instead: an invented sticky follow mode**, as three commands and three menu items rather
than a setting, so the faithful one-shot is never silently redefined and there is no default to
argue about:

- "Make all mascots dash to the mouse (once)" — real `setBehaviorAll("ChaseMouse")`, unchanged.
- "Keep all mascots following the mouse" — while set, a *finished* behavior re-runs ChaseMouse
  whenever `|cursor.x - mascot.x| > FOLLOW_REACQUIRE_PX`.
- "Stop all mascots following the mouse".

`FOLLOW_REACQUIRE_PX = 240` is not arbitrary: ChaseMouse's final Dash targets `cursor.x + Gap` where
`Gap` is up to `Math.random()*200` *short* of the cursor, so a mascot that just finished chasing can
legitimately be sitting 200px away. A threshold at or below that would leave it permanently
mid-dash, never reaching the sit-and-watch chain. Inside the radius the pack's own chain runs
untouched, which is what makes the mode read as "arrives, then watches you".

The interception point is deliberately narrow — the single moment a behavior ends, substituting
ChaseMouse for the weighted pick. Nothing about how actions run is touched.

**Process note.** The first trace of this appeared to show a severe bug: 14px of movement in 40
ticks, with 30-tick stalls. That was the harness, not the engine — it built a fresh `new Random(7)`
on every tick, so every `Math.random()` in the pack returned the same first value, collapsing
ChaseMouse's randomised Dash targets to a near-zero hop. Real `BehaviorAI` holds one RNG for the
mascot's life. Worth recording because the fake was *plausible* — it reproduced the reported symptom
closely enough to have been "fixed" with an invented continuous-chase rewrite of ChaseMouse, which
would have destroyed a faithful behavior to solve a bug that did not exist. Confirming the harness
before believing its output is the cheap step that avoided that.

## Pass 23: sticky follow redesigned as a real pursuit (2026-08-14)

Two user follow-ups on the sticky mode added in the previous commit: a hypothesis that it breaks when
the pointer leaves the window or the mascot's pane, and a requirement — "sticky follow shouldn't be
timed action. Until it reaches the pointer or i touch mascot to end action."

33. **The pointer tracker listened in the bubble phase.** `window.addEventListener("pointermove", …)`
    with no capture flag: any handler between the event target and `window` can starve it with a
    single `stopPropagation()`, and Obsidian's editor surface and various of its UI components do call
    that on pointer events. That is exactly the reported symptom — chasing that works over some panes
    and silently freezes over others — and it is invisible from the outside, because the ambient
    position just stops changing rather than erroring. Moved to `{ capture: true }`, which runs on the
    way *down* from window to target before anything downstream gets the chance. (The matching
    `removeEventListener` needs the flag repeated: a capture registration is a *different*
    registration from the same function without it, so removing the wrong one silently leaks the
    listener for the life of the window.) Not confirmed as *the* cause of what the user saw — it is a
    latent starvation bug found while checking the hypothesis, and worth fixing on its own merits.

34. **Re-running ChaseMouse was the wrong mechanism, and the 240px threshold was covering for it.**
    ChaseMouse cannot close the last stretch by construction: its final Dash targets `cursor.x + Gap`
    with `Gap = -Math.min(distance, Math.random()*200)`, so once the pointer is inside 200px that
    target collapses onto the mascot's *own* position and the Dash is a no-op. The previous commit's
    `FOLLOW_REACQUIRE_PX = 240` existed purely to stay outside that dead zone — which meant the mode
    could never satisfy "until it reaches the pointer", only "until it is roughly nearby". Replaced
    with direct pursuit legs: an ordinary pack `Move` (`Dash`, falling back to `Walk`) aimed at the
    pointer's live x, capped at `FOLLOW_LEG_PX = 160` so a Move committing to its target can't hold a
    stale aim for long, and terminating at `FOLLOW_ARRIVAL_PX = 32`. Still strictly additive: the only
    interception point is the moment a behavior ends, substituting a target for the weighted pick.

35. **Arrival must not disarm the mode** — a bug I wrote and then caught in a trace within the same
    pass. Clearing `followingMouse` on arrival reads as a literal interpretation of "until it reaches
    the pointer", but it turns "keep following" into a single trip: the trace showed the mascot arrive
    at t65, stand down, and then completely ignore the pointer being moved 970px away at t120. The two
    lifetimes are separate — a *pursuit* ends by arriving; the *mode* ends only when cancelled. While
    arrived it just stops issuing legs and lets the pack's own SitAndFaceMouse chain run, staying
    armed. Pinned by a test that arrives, then moves the pointer, then asserts it chases again.

36. **Touching the mascot cancels it**, per the request. Placed at the very top of `pointerdown`,
    ahead of the hotspot scan and every drag check, and unconditional on whether either of those goes
    on to claim the click: grabbing it, poking a hotspot and plain clicking it are all
    unambiguously "stop coming after me".

Test note: the "switched off" case is asserted on the *mechanism* (no further pursuit is issued —
detectable because a pursuit leg is the only thing that can make ChaseMouse current, the pack giving
it `Frequency="0"` in the general pool) rather than on position, since once following stops the
ordinary autonomous wandering resumes and can carry the mascot near the pointer by chance. It also has
to drain the in-flight action first: switching off stops *new* pursuits and deliberately does not
abort the action already running.

## Pass 24: two live bugs from the Sound feature (2026-08-14)

Reported from a real multi-character pack (Eevee_Egg / Umbreon / Umbreon_Shiny) via a console
screenshot: a wall of "references sound X but no file was found" warnings, plus a condition parse
failure.

37. **Every sound file failed to resolve, for every pack.** Pack authors write `Sound` exactly the
    way they write `Image` — pack-relative with a leading slash, `Sound="/197 - Umbreon.wav"`.
    `resolveImage` has always stripped that (`rawPath.replace(/^[/\\]+/, "")`); the sound path
    builder did not. Worse, it probed the *raw* joined candidate with `adapter.exists()` while only
    passing the normalised path to `getResourcePath` — so the path that was tested was never the path
    that would be used. Every candidate came out as `.../sound//197 - Umbreon.wav`, missed, and sound
    was silently dead for every pack that actually shipped any. Both halves fixed: strip the leading
    separator *and* normalise before probing.

    This is the second time in this project that a path bug survived because the check and the use
    went through different normalisation. Worth stating as a rule: **probe the exact string you are
    going to use.**

38. **One warning per missing file made the console unusable.** A pack declaring a dozen sounds
    produced a dozen near-identical warnings at load, three packs producing thirty — which is what
    the screenshot actually showed, and it buries real problems. Now one line per pack, listing the
    count, the three folders it looked in, and the missing names. Sound is off by default, so this is
    informational for most users and must not shout.

39. **A pack condition parsed as `#{mascot.totalCount 50}`** — two operands, no operator. The
    tokenizer handles `<`/`>` and *throws* on unknown characters, so the operator was genuinely
    absent from the attribute string: `<` and `>` are not legal raw characters inside an XML
    attribute value, and a pack writing a bare `<`, or `&lt` without its semicolon, can end up parsed
    with the operator dropped. Not our bug to fix — but our warning quoted only the expression text,
    which looks *almost* right, so the actual defect was invisible and unlocatable. `parseCondition`
    now takes a context label (threaded through both parsers: action name, behavior name, which
    `<Animation>`, which transition edge) and, when the failure has the two-operands-no-operator
    shape, says explicitly that a comparison operator looks XML-dropped and must be written `&lt;`.

    The user's pack files are not in this repo, so this was diagnosed from the tokenizer's own
    behavior rather than by reading the offending XML — stated as a likely cause in the warning, not
    asserted as fact.

**Testing note.** `PackLoader` is the one module here importing a *value* from `obsidian`
(`normalizePath`), and the real package ships types only with no runtime entry — so Vite could not
resolve the id at all and `vi.mock` never got a look in, which is why the loader had no tests despite
being the thing that reads the user's actual files. Added `test/stubs/obsidian.ts` plus a
`resolve.alias` in vitest.config.ts. The stub implements `normalizePath` faithfully rather than as an
identity function, because a lazy stub there would have let this exact path bug pass. Three of the
four new loader tests were confirmed red against the previous commit before being accepted.

## Invented: pane and sidebar wrangling (2026-08-14)

Requested as the Obsidian-native replacement for the original's window throwing: squash a stacked
pane by landing on it, haul its bottom edge down from underneath, shove side-by-side panes apart,
collapse a sidebar. Entirely invented — but the constraint that shaped it is a real property of the
original, and worth recording.

**Why the design is "params on existing actions" rather than new actions.** shimeji-ee animates
window manipulation by clipping the sprite against the window frame, so the mascot appears to grip
an edge from behind. A DOM overlay cannot clip against a pane it does not own, so that whole visual
vocabulary is unavailable and these interactions have to borrow animations the pack already has. A
new `<Action>` would need its own `<Pose>` list and therefore hardcoded image filenames — fatal for
a multi-character pack whose sprite sheets differ. A *param* attaches to an action referenced **by
name**, so `paneWrangling.ts` never mentions a single image. Two params: `PaneResize` (px per tick,
plus `PaneResizeByFacing`) and `Sidebar` (a one-shot collapse/expand/toggle).

Which pane and which axis are derived from what the mascot is touching (`resolveActivePaneLedge`,
the same resolution the pack's own `activeIE.*` conditions use, so the two cannot disagree) — never
from the author. A floor or ceiling is a horizontal edge and therefore resizes **height**; a wall
resizes **width**. That removes a whole class of "squash resized it sideways" bug by construction.

Three things found while building it, each of which would have shipped broken:

40. **A param read off the top frame would have done nothing for most real actions.** `HoldOntoCeiling`
    and `HoldOntoWall` are *Sequences* whose only job is to hand a `Duration` to `GrabCeiling`/
    `GrabWall`; the frame on top of the stack when a per-tick effect fires is therefore the child,
    not the one carrying the param. `PaneResize` is now resolved at push and **inherited by child
    frames**, with `hasOwnProperty` rather than a truthiness test so an explicit `PaneResize="0"` on
    a child still means "stop" instead of falling back to the parent's value.

41. **The mascot has to ride the edge it pushes, or the interaction kills itself.** A mascot hauling
    at 6px/tick is 12px adrift after two ticks — past `LOST_GROUND_REACH` — and the hold aborts
    straight into `Fall`. `ridePaneEdge` moves it with the edge, and only when `resizeBy` reports it
    actually resized: a pane at its clamp, a wrong-axis split, or the feature switched off all
    return false, and riding an edge that did not move would walk the mascot off it for free.
    Deliberately limited to floor/ceiling, where `resizeBy`'s neighbour choice makes the edge's
    direction of travel unambiguous. A vertical edge has no such guarantee, so a shove is left to
    lose its grip and drop — which reads fine, and is why `PaneShove` is short.

42. **`resizeBy` at a clamp used to keep requesting layout passes forever.** It now returns false
    when the computed dimension is unchanged, instead of re-setting identical values and calling
    `requestResize()` on every tick of a mascot leaning on an already-minimum pane.

Also: `resizeBy` gained an optional axis constraint and a boolean return; `splitAxis` derives the
axis by **comparing sibling rects** rather than reading Obsidian's `mod-vertical`/`mod-horizontal`
class names, which are a convention with no stability promise and are easy to get backwards.
`setSidebar` is the one part of this that uses only documented API (`WorkspaceSidedock.collapse/
expand/toggle`), typed structurally so mobile's `WorkspaceMobileDrawer` satisfies it too.

The overlay is applied *before* the user's own custom content in `refreshAvailablePacks`, so
authoring an entry of the same name replaces it — it is a default, not a privileged built-in — and
`Shimeji/conf/actions.xml` remains untouched, as it has throughout.

**Testing note.** The first attempt at these tests asserted absolute positions against a *static*
fake ledge, and was measuring the floor code rather than this feature: the landing snap pins the
mascot back to the unmoved edge every tick, hiding any follow bug completely. The fake now models
what Obsidian actually does — a successful resize moves the pane, and the ledge is recomputed — and
the assertion is that the mascot and the edge end up in the same place. One test also pins the
Sequence-inheritance case from entry 40 specifically, since that is the shape that broke first.

### Known gap, requested for later

Authoring genuinely *new* animations from inside Obsidian — importing frames and scripting a pose
timeline — rather than only recombining a pack's existing actions. `CustomContentBuilder` and the
settings editor already construct actions/behaviors from specs and `CustomPoseSpec` already carries
image/anchor/velocity/duration; what is missing is an image-import path into the pack folder and a
timeline UI over `CustomAnimationVariantSpec.poses`.

## Invented: route-finding over the ledge graph (2026-08-14)

Requested as "with mouse following I want it to path trace vertically too... want them to jump more
between panes". Both halves come from one capability, so it is built as one: a router over the same
`Ledge` list the physics already uses.

**Nothing to port.** shimeji-ee's mascots live on one desktop with a handful of tracked windows, and
every movement behaviour in it is authored per-surface — "walk to a random x on *this* floor", "climb
*this* wall to a random y". The original never asks how to get from one surface to another, so there
is no algorithm here to be faithful to. Obsidian's layout is denser and far more vertical, and that
question is exactly what makes a mascot look like it inhabits the window rather than patrols a floor.

`engine/Routing.ts`: Dijkstra over ledges. Edges are corner joins (surfaces that physically meet),
jumps up to a nearby higher floor within a budget, and drops off the end of a raised floor. Five step
kinds — walk / climb / traverse / jump / drop — chosen precisely because each maps to an action the
standard pack already has (`Dash`, `ClimbWall`, `ClimbCeiling`, `Jumping`); a route the pack cannot
animate is not a route. Keyed by ledge rather than (ledge, point), which can in principle settle for
a slightly worse entry point: a deliberate trade, since the graph is tens of nodes and is rebuilt
every leg.

Used by two things: pursuit (one step per leg, re-planned each leg so a moving pointer changes the
plan at the next junction) and a new autonomous roam.

Three bugs found while building it, two of them only visible in a live trace:

43. **The route contained zero-length steps, and they deadlocked the pursuit.** A corner transfer
    legitimately arrives at the point it departs from — changing which surface you are attached to
    does not move you — so the raw path has them by construction. As *instructions* they are poison:
    the caller turns each step into a targeted Move, which completes on its first tick, re-plans,
    produces the same zero-length step, and never progresses. Observed as a mascot walking to the
    foot of a wall and then standing there indefinitely. `withoutStandingStill` drops them; the
    surface change is still carried by the next step, which names the new ledge.

44. **Handing a wall climb a `TargetX` made it finish instantly.** Real `Move` treats a supplied
    target as a completion condition, and the pack's own references bear this out — every
    `<ActionReference Name="ClimbWall" .../>` in actions.xml passes `TargetY` and nothing else. The
    first version passed both axes for every step, so a climb starting at the wall it was already
    standing at was complete before it began. Same visible symptom as the bug above, which is why
    both needed a trace rather than reasoning to separate.

45. **Roaming made mascots appear to chase the mouse spontaneously.** `startRouteAction` attributed
    every leg to ChaseMouse — correct for pursuit, since it makes the pack's own post-chase chain
    follow — but a self-directed wander is not a chase. It broke the existing invariant test that
    real shimeji-ee has no autonomous ChaseMouse trigger, and would also have sent a wandering mascot
    into sit-and-watch-the-pointer afterwards. Attribution is now a parameter; roaming passes none.

**A design point worth keeping.** Arrival is decided by the *router*, not by distance to the target.
A pointer hovering over the middle of the editor is not somewhere a mascot can stand, and measuring
against it directly would leave one re-planning forever, never settling into the pack's own chain. An
empty route means "nowhere nearer to go", and both callers use it as their stop signal. `arriveWithin`
exists on `RouteOptions` for exactly this: without it, a mascot one pixel off its goal would be handed
a one-pixel leg indefinitely.

Roaming is deliberately built on the same "intercept the moment a behaviour ends" seam as sticky
follow — it never interrupts an action and never changes how one runs — and is checked *after*
pursuit, so being asked to follow always outranks a self-chosen expedition.

## Pass 25: sticky follow re-aims continuously (2026-08-14)

Correction to entry 43's design note, from the user: *"It doesn't have to be the closest point.
That's why on click mascot stops the action. But if I wanna tease it and make it follow my mouse
round and round the screen for several minutes I want to have the option."*

That is right, and the previous design had the priority backwards. Terminating at the closest
reachable point solved a problem I had created (an empty route with nothing to run spins), and paid
for it with the mode's actual purpose. The cancel signal was always meant to be the user — clicking
the mascot, or the stop command — not the mascot deciding it had got near enough.

46. **Re-aim on pointer movement, not on action completion.** Sticky follow only reconsidered when a
    behaviour *ended*, so leading a mascot around meant it committed to a stale target, arrived where
    the pointer had been, settled into one of the pack's own idles (seconds long), and only then
    noticed. `FOLLOW_REAIM_PX = 64` abandons the current leg once the pointer has genuinely moved —
    small enough that being led around reads as continuous chasing, large enough that hand jitter
    doesn't restart the animation several times a second. It is also what stops a mascot parking at
    the closest reachable point: that answer is only allowed to stand while the pointer it was
    computed against does.

    Fall, Thrown and Dragged are explicitly exempt. Those are the engine's own physics behaviours
    rather than something the mascot chose, and interrupting a fall to go chasing would leave it
    moving under its own power in mid-air.

47. **The re-aim never armed on the first pursuit.** Turning the mode on starts the pack's own
    ChaseMouse — a scripted sequence several seconds long — and `pursuitAimedAt` was only recorded
    when a *pursuit leg* started, which cannot happen until that sequence finishes. So the first few
    seconds after switching the mode on, exactly when someone is most likely to be moving the pointer,
    ignored it completely. Armed lazily in `tick` instead.

**Testing note.** The first version of the "led around" test asserted total distance travelled, and
failed at a threshold I had picked by guess. Investigating rather than lowering it was the right call:
a pointer held in open space sends the mascot up a wall, and this pack's climb is genuinely slow
(a fraction of a pixel per tick), so a lap spent climbing legitimately covers a fraction of one spent
dashing. Distance was measuring the pack's animation speed, not the thing under test. The assertion is
now on pursuit *ticks* per lap — a mascot that stood down shows none at all, since ChaseMouse can only
be current while a pursuit leg runs — which is both precise and immune to how fast any given pack
happens to move.

## Invented: "get to that spot" orders, with layout surgery (2026-08-14)

Requested as the answer to a limitation I had described as inherent: *"A pointer hovering over the
middle of the editor isn't somewhere a mascot can stand. Mascot can manipulate panes. Let's add him
option to open new panes. This combined will allow the mascot to reach any point on screen. If not
reachable in current layout, make layout to reach it."*

That is right, and it closes the gap properly rather than working around it. A pane divider *is*
somewhere a mascot can stand, and one can be created at any coordinate: split the pane containing the
point, then slide the resulting boundary onto it with the resize path that already exists. Any point
becomes reachable.

Deliberately scoped to an **explicit order**, not to following or roaming. A pointer sweeping across
the editor is not a request to rearrange someone's workspace; a shift-triple-click at one specific
place is. So following still stops at the nearest surface, and only `orderToSpot` reshapes anything.

- `PaneActions.makeSurfaceAt(point)` / `closePane(pane)` — the split uses documented API
  (`Workspace.createLeafBySplit`, `WorkspaceLeaf.detach`); placing the divider reuses `resizeBy`.
  Which of the two resulting panes ended up lower is *measured*, not inferred from Obsidian's
  `'horizontal'`/`'vertical'` naming, for the same reason `splitAxis` measures.
  **Superseded in Pass 28:** `makeSurfaceAt` did the whole operation in one silent call, which the
  user correctly read as the mascot having magic. It is now two steps the mascot physically performs —
  see `listNewPaneControls`/`pressNewPaneControl` there.
- Bounded at two surgeries per order (`MAX_SPOT_SURGERIES`). Each one splits a real pane, so a spot
  that can never be reached must not become an endless run of new panes.
- The created pane is left standing — closing it the instant the mascot arrived would drop it — so
  cleanup is an explicit command.
- Gated by `allowLayoutSurgery`; with it off the order still works, limited to existing surfaces.

48. **Judge the layout by where the route *ends*, not by whether one exists.** The first version only
    considered surgery once `findRoute` came back empty. But the router nearly always finds
    *somewhere* — a wall, the ceiling — so the mascot first climbed all the way to whatever distant
    surface happened to be nearest the spot, and only then concluded the layout could not deliver.
    Checking the shortfall between the route's endpoint and the spot up front makes it split the pane
    immediately and walk to the real destination, which is what "get there no matter what" should look
    like. Found because the bounded-surgery test never triggered a single surgery.

**Two test-fidelity failures worth recording, both of which reported working code as broken.**

- The first version asserted the mascot's position a fixed number of ticks *after* issuing the order.
  But an order completes and then the pack's own behaviours resume and wander the mascot off, so that
  assertion was measuring the pack's idling. It reported a perfectly executed order as a 134px miss.
  Tests now run only until the order is discharged, and assert the position at that moment.
- The fake `makeSurfaceAt` appended a bare floor ledge at the requested y. A real split does not add a
  floating line — it *replaces* a pane with two panes meeting at that boundary, and the resulting
  walls are what a mascot actually climbs to get up there. The floating floor was unreachable by
  construction, so the test could only ever prove the order gave up. The fake now splits a rect and
  re-derives ledges through the real `computeLedgesFromRects`.

The gesture itself is deliberately passive: Shift + three clicks within 700ms and 24px, watched in the
capture phase (a bubble listener on `window` can be starved by any `stopPropagation` in between — the
same trap as the ambient pointer tracker), never calling `preventDefault`. Requiring Shift is what
makes watching every click acceptable at all; a bare triple-click is ordinary text selection.

## Pass 26: route costs are time, not distance (2026-08-14)

From the user, on the spot-order feature: *"Did you consider that mascot can fall through spot by
climbing the ceiling than dropping or jump to wall is a big animation and if able to calculate before
he might be quicker reaching point doing one of those than creating new panel and climbing it."*

The underlying observation is right and exposes a real defect in the router: it costed routes by
**distance**, and the standard pack's movement speeds differ by more than an order of magnitude.
Measured from actions.xml:

| movement | px per tick |
| --- | --- |
| `Jumping` (`VelocityParam="20"`) | 20 |
| `Dash` | 8 |
| `Walk` | 2 |
| `ClimbWall` / `ClimbCeiling` | **0.64** (36px spread over 56 ticks, most of them hold frames) |
| `Falling` | accelerating at Gravity=2, so a drop of d takes ~sqrt(d) ticks |

Climbing is 12× slower than dashing and 31× slower than jumping. The old multipliers priced a climb
at ×1.25 (roughly a walk) and a jump at ×1.6 — *more* expensive than walking. Exactly backwards, and
it made the router send mascots up long slow walls in preference to routes they could have jumped or
dropped in a fraction of the time.

49. **`stepCost` now returns estimated ticks**, from per-movement speeds on `RouteOptions` (defaults
    measured from the standard pack; a pack whose animations differ can pass its own). Drops use
    `sqrt(2d/g)`, which is sublinear — long drops are proportionally *cheaper*, which is precisely why
    they are worth preferring over climbing back down.

50. **Goal selection needed a caller-supplied weight, and finding that out was the useful part.**
    Switching to real costs immediately broke the spot-order test: with climbing correctly priced, the
    router concluded that a 469-tick climb was not worth closing the last 300px and aimed at the
    window floor instead. Correct for *following* — chasing a pointer across the window really isn't
    worth that, and a mascot that tries looks broken rather than diligent — and wrong for an explicit
    order, whose entire promise is reaching the point. So `travelTimeWeight` is a parameter: following
    uses the default, orders pass ~0.05. Without it one of the two is always wrong.

The user's specific "fall through the spot" idea is now *reachable* by the router rather than
special-cased: a drop that passes through a mid-air point is a cheap route by this cost model, where
under distance costing it was indistinguishable from a slow climb. What is still not implemented is
deliberately *planning* a pass-through — routing to a surface directly above a mid-air spot in order
to fall through it — and comparing that against layout surgery. Noted as the next step rather than
claimed.

## Pass 27: planning a fall-through, and costing it against surgery (2026-08-14)

The step left open at the end of Pass 26: deliberately *planning* a pass-through rather than merely
making one cheap enough for the router to stumble into, and weighing it against layout surgery.

51. **`planDropThrough`** finds somewhere to let go so the resulting fall passes straight through a
    mid-air point. Two kinds of departure qualify — a **ceiling** spanning the spot's x, which the
    mascot hangs from and releases, and the **edge of a floor** directly above, which it simply walks
    off. A floor's middle never qualifies, for the obvious reason that there is floor underfoot there.
    The fall must also be unobstructed: the first floor below the departure point has to be *below*
    the spot, or the mascot lands before reaching it.

52. **`routeDurationTicks` / `fallDurationTicks`** expose the same estimate the search minimises, so
    whole *plans* can be compared rather than only surfaces. That is what turns "which is quicker" from
    a guess into a number.

53. **`chooseSpotPlan` costs both and picks.** Neither is hardcoded as preferred, because which wins
    genuinely depends on the layout: a single full-window pane makes the only ceiling 760px of climbing
    away (~2170 ticks all told) against ~570 for splitting and climbing the new divider, while a mascot
    standing on a pane whose edge is above the spot drops through for a few dozen. The surgery estimate
    is honest rather than notional — it routes against the graph *as it would be* with a floor at the
    spot, which is exactly what the split produces.

54. **Arrival is now checked every tick, not at behaviour boundaries.** A pass-through puts the mascot
    within range for a tick or two on the way past; the old end-of-action check sailed straight through
    it, so the order could never be satisfied by falling. It also makes ordinary arrivals crisp instead
    of waiting out whatever step happened to be running.

**The bug this pass turned on.** The first version of `chooseSpotPlan` reported `surgeryTicks:
Infinity` for a case where splitting was obviously viable, and therefore chose a 2170-tick climb over
a 570-tick split. The synthetic floor it routed against spanned only ±400px around the spot — so it
touched no wall, nothing in the graph connected to it, and every route to it cost Infinity. Spanning
the containing pane (or, failing that, the whole window) fixes it, and is also what a real split
actually produces. Worth recording because the failure mode was silent: a plan comparison that
concludes "impossible" looks identical to one that concludes "worse", and the mascot just quietly did
the slow thing.

Found by dumping both numbers rather than reasoning about the code — the isolated calculation gave
569, the live path gave Infinity, and that discrepancy was the whole diagnosis.

## Pass 28: physical layout surgery, and standing over hanging (2026-08-14)

Two user reports, both about a mascot doing something that reads as wrong rather than as a mascot:

> *"when mascot does surgery it cant be magic. he has to go to top op some pane to plus button to add
> new pane. to move the pane or resize it he needs to use the animations like pushing puling or
> jumping on pane to make it how he needs. not that he summons pane into position it needs. When
> planing way he can use all resources at once, adding moving pane and dashing to reach the spot."*

> *"obsidian has sometimes more lines at one spot and mascot sometimes chooses to clim cieling insted
> of wwalk when both lines are near enoug, implement logic that if he can choose to stand he should
> choose that not be upside down"*

### Surgery is now two physical steps, not one silent one

`PaneActions.makeSurfaceAt(point)` is **gone**. It was the whole operation in one call — a pane
appeared, already positioned, wherever the mascot decided it wanted a floor. In its place:

55. **`listNewPaneControls()`** reports where Obsidian's real new-tab buttons are
    (`.workspace-tab-header-new-tab`), so a mascot can route to one like any other destination.

56. **`pressNewPaneControl(near)`** presses one, *without positioning anything*. It returns whatever
    split Obsidian gives it. Deliberately does less than `makeSurfaceAt` did: this is only the half a
    button press can honestly account for.

57. **`BehaviorAI.spotPhase`** is the state machine that strings those together — `toControl` (route
    to the button and press it), then `shapeDivider` (get onto the new pane's top edge and shove it,
    at `DIVIDER_SHOVE_PER_TICK` = 7px/tick, using the pack's own `Sit`/`Stand` carrying a `PaneResize`
    param — exactly the mechanism ordinary pane wrangling uses). `dropFrom` is the third phase, from
    Pass 27.

58. **The cost estimate is now a chain, which is the "use all resources at once" part.** It is
    `walk to the button` + `route from the button to wherever the split actually lands` + `the shove`.
    Two details make it an estimate of the real operation rather than of a wish: it starts the second
    leg *at the button* (the mascot is standing there by then, not back where it set off), and it
    models the divider landing at the host pane's **midpoint**, because that is where a 50/50 split
    puts it — costing it as if it arrived at the spot was what made surgery look free.

    The old estimate priced a full-window-pane split at ~570 ticks. The honest one prices the same
    operation at ~3800, because reaching a button at the top of the window means traversing the
    ceiling at 0.64px/tick. That flips the decision to dropping, correctly.

59. **`pressNewPaneControl` measures instead of trusting `SplitDirection`.** The mascot needs a
    *horizontal* edge; which of `"horizontal"`/`"vertical"` produces that is the same naming coin-flip
    `splitAxis` already exists to avoid asserting. So it tries one, measures the result against the
    sibling, and takes the other if the panes came out side by side, detaching the loser. Bounded to
    two attempts.

### Standing beats hanging

60. **`RouteOptions.uprightPreference`** (80px) is added to a candidate surface's score when it is not
    a floor. Obsidian puts a pane's underside and the next pane's top edge on the same line, so
    "closest surface" is constantly a near-tie broken arbitrarily. Big enough to settle those
    decisively, small enough that a ceiling genuinely nearer still wins.

61. **`nativeBehaviors` no longer keeps a ceiling attachment while grounded** — `physics.currentCeiling`
    is only resolved when `!physics.grounded`. A mascot standing on a floor with a pane underside a few
    pixels above it was registering as attached to both.

### Three bugs this pass turned on

**An infinite release/land loop.** With two stacked panes, `planDropThrough` happily picked the upper
pane's underside as a departure — and the lower pane's *top edge is on the same line*. The mascot let
go, landed instantly on the floor it was already standing on, was still not at the spot, and planned
the identical drop again, forever. The obstruction test started its search a pixel *below* the
departure, which excluded exactly the floor that makes the drop impossible. Now any floor at or below
the departure line blocks, with the departing ledge exempt **by identity** rather than by height —
which is what still lets a mascot walk off the end of a floor while a same-level sibling beside it
correctly blocks the fall. Belt and braces: `spotSpentDrops` remembers departures already used, since
a drop that did not deliver will not deliver on a second attempt either.

**Pane wrangling moved the pane at full rate and the mascot at none.** `applyPaneSideEffects` ran
*before* the frame's own tick, so `applyGravityAndLand` re-anchored the mascot to the stale ledge in
the same tick and undid the ride. It only half-shows: the mascot still creeps along, 7px adrift,
visibly fighting an edge it is also pushing. Moving the call after `tickFrame` fixes it — the new
position then survives to the next tick, by which time the rebuilt ledge list agrees with it.

The reason this survived fifteen passing tests is worth recording: the existing `paneWrangling` fake
moves the ledge object *synchronously* inside `resizeBy`, which the real host cannot do (Obsidian only
recomputes once the DOM settles). A test that models the real timing — rebuild the ledge list
*between* ticks — fails against the old ordering by exactly the predicted 6px.

**Two "standing beats hanging" tests that passed either way.** Both were near-ties the router already
happened to break in favour of the floor, so they agreed with the new behaviour without depending on
it. Replaced with one where the ceiling is genuinely *nearer* the target (10px against 30px) and
therefore wins outright without the preference. Same lesson as the `makeSurfaceAt` fake in Pass 26 and
the `normalizePath` stub in Pass 24: a test built to agree with the change proves nothing. Every fix
in this pass was checked by stashing `src/` and confirming the new tests go red.

## Pass 29: auditing the test suite itself (2026-08-14)

324 tests is a lot, so: are they all needed, do any contradict, should any merge?

**No two can contradict.** All 324 passed, and two tests asserting opposite outcomes for the same
input cannot both pass. The question that *is* answerable is which tests carry independent signal —
so it was answered by mutation testing rather than by reading: introduce a deliberate bug, run the
suite, record exactly which tests fire. A test that never fires alone across every mutant aimed at
its subject is not testing anything the others aren't.

**Removed 5, all subsumed by an exact-recurrence test.** `tickDragFootX` and `smoothCursorVelocity`
are two-line branchless ports, each with a test pinning three successive outputs to 5–10 decimals.
Any change to either formula must fail that test, which makes "it lags rather than snapping", "it
converges on a sustained position", "it decays to zero when the cursor stops" and "it stays put once
the gap closes" consequences of it, not independent facts. Each had its own test; none could fail on
its own. Their content is now a comment on the test that does the work — the knowledge was worth
keeping, the extra execution wasn't.

Two survivors from those blocks earn their place, and mutation testing is what showed it: the exact
values are all positive and all on x, so an `abs` mutant and a y-copies-x mutant both pass the
recurrence test and fail only "lags in the correct direction on both sides" and "x and y are computed
independently" respectively.

**Found a test that overclaimed.** `stage.test.ts`'s *"a spawn with no explicit position falls in
from above the screen at a random x"* did not test the random x. Its assertion was `0 <= x < 800`,
which a spawn hardcoded to the middle of the window satisfies perfectly — replacing
`rng.range(0, viewport.width)` with `viewport.width / 2` passed the entire suite. Split into two
tests, with the randomness now checked the way the neighbouring facing test checks it (30 spawns,
assert the spread is real). The suite got smaller and strictly stricter.

**Kept, with evidence.** Several clusters looked redundant and are not — each member caught a mutant
alone:

- The four `lostGround` tests (Move/Stay × wall-present/wall-gone). The negative controls are what
  stop a check that always fires: an `if (true)` mutant is caught *only* by them.
- The `clampToWalls` left/right pair and the `Breed` x/y offset trio — one branch each.
- The three spot-order surgery tests added in Pass 28. Pressing the button from anywhere fails only
  the "walks to a real + button" test; never shoving the divider fails only the other two.

**Merge candidates deliberately not merged.** Mirror pairs (left/right, present/absent) could each
collapse into one test with two assertions. Left alone: they cost one line of setup each and buy a
failure message that names the broken direction. That is a style preference, not redundancy — unlike
the five removed above, which bought nothing at all.

## Pass 30: every descent stalled — three pixel-wide mismatches (2026-08-15)

Reported live: "spot order works better but mascot still has trouble with spots on lower levels than
he is or on levels too far from him", and separately "he can stand in middle of two panes then calling
him doesn't work, he stands still".

Method: drive spot orders end to end against the user's real card-themed layout (1748x1392, 6px pane
gaps, 3px inset from the window walls) in nine directions, until the order is discharged.
**Five of nine never finished.** Every existing unit test passed throughout — they check the router and
the physics separately, on tidy synthetic geometry, and each failure here is the two *disagreeing* by a
few pixels so that carrying out the plan returns the mascot to where the plan was made.

1. **Drops stepped inward.** `letGoAndFall` nudged toward the route step's target, but a drop step
   names where the mascot will *land*, and the landing point is nearly always back under the middle of
   the floor being left. The mascot let go one pixel inside the ledge it was standing on, gravity put it
   straight back, the order re-planned the identical drop. Direction now comes from the floor, and the
   step is absolute so a mascot stopped short of the edge still clears it. This one bug accounted for
   every "go somewhere lower" failure, since descending always ends in a drop.
2. **Corner joins named points on neither surface.** `spansX`/`spansY` allow `JOIN_EPS` of slack, but
   the corner was a single shared point. A card theme spends every pixel of it — one pane's bottom edge
   sits 6px above the next one's top — so the router ordered a climb 6px past the end of its own wall.
   That never completes, and the two surfaces each planned the reverse leg of the other: a mascot
   ping-ponging across the gap for the full 320s of a run. Departure and arrival are now clamped onto
   their own surfaces separately.
3. **Physics stricter than the router about ceilings.** A pane's underside stops 3px short of the
   window wall, so a mascot pinned there by `clampToWalls` was outside the span of the ceiling it was
   plainly touching: climb, no ceiling, lost border, fall, climb again. `findCeilingAt` now allows the
   same slack the joins do.

Two consequences of the same measurements: a drop off an edge with no room to step past (the topmost
pane floor stops 3px from the window wall) is not offered at all, and the step-off now exceeds
`WALL_CEILING_ADHERENCE_REACH` so it does not leave the mascot clinging to the wall it stepped past.
`edgeStepOffX` is shared by router and mascot so the router can only plan departures the mascot can
perform.

`test/spotOrderAcrossLayout.test.ts` drives the whole loop; 7 of its 9 cases fail without the fixes.

**Not a bug, reported as one:** "he was going to all previously marked spots in order". There is no
queue — `orderToSpot` replaces. Orders go to whichever mascot is *nearest* the click, so several given
in a row land on several different mascots and run at once. `shimejiDebug.where()` now has an `ordered`
column to make that visible. Whether a new order should instead always go to the same mascot is an open
design question, not a defect.

## Invented: the plant room (2026-08-15)

A sidebar pane that is a place a mascot can live in. **Invented**, and it could not be otherwise:
shimeji-ee's mascots live on the desktop among tracked application windows, and there is nowhere for
one to *be* other than that desktop. Obsidian gives us a pane we control completely.

**The furniture is the level.** `room/roomDef.ts` declares each fixture's `paint` and its `surfaces`
together, so one declaration produces both the picture and the collision geometry. Nothing can look
standable and not be, or the reverse. It also means a second room is a second data file — the same
road as authoring animations in-vault. Nine standable surfaces and six hangable ones: floor, sofa
seat/back/both arms, three bookshelf levels and three shelf undersides, windowsill top and underside,
a snake-plant pot rim as the step from floor to shelf, the hanging pothos, and the ceiling.

**Confinement is the absence of an edge, not a rule.** `Mascot.confinement` substitutes the resident's
whole world (`Stage.ledgesFor` consults it first). There is no "may I leave" check anywhere, because a
route out cannot be planned over a graph with no edge leading out — router, pack behaviours and
physics all agree without any of them knowing rooms exist. A check would have to be repeated at every
one of those sites and would be wrong the first time one was missed. Asserted directly in
test/plantRoom.test.ts by routing at five points far outside and requiring every step to stay inside.

**Both sidebars.** The door faces the workspace the mascot came from, so the whole room — art *and*
geometry — mirrors when the pane is on the other side. Decided from the pane's own rect rather than by
asking which sidebar it is in, because the question that matters is "which side is the rest of the
window on", and that answers the same way even if the room is dragged into the main area. Mirroring a
wall also swaps its `side`: get that wrong and the pack's `lookRight ? leftBorder : rightBorder`
checks answer about the wrong face, leaving nothing eligible and ending in the respawn safety net.

**The two transitions** are the only parts that need arranging, and both go through the threshold.
Moving in aims the order at the *outside* of the door (a point on the pane's own edge, which is a wall
the workspace graph already has) because the room's interior is not in that graph. Called out, the
resident walks to the door first; crossing it is what returns it to the workspace, and the original
destination is re-issued on the far side. Dropping a mascot in moves it in; carrying one out moves it
out and leaves it where it was put.

**One resident.** The first arrival removes every other mascot from the screen — the user asked for
exactly this. Nothing on disk is touched; it is the same removal "Remove all mascots" performs.

Edges handled: pane closed or sidebar collapsed → the resident is neither simulated nor drawn, and
resumes where it was (a confined mascot handed an empty ledge list would fall out of the world);
resident removed by something that never heard of the room → noticed in the residency tick rather than
by hooking every removal path; thrown out by release velocity → pulled back, since `clampToWalls` is
deliberately window-only and cannot cover a room; restart → `roomResident` persists *who* lives there,
wrapped rather than a bare pack id because `packId: null` is itself meaningful (the placeholder
character), so a bare null could not distinguish "nobody home" from "the plain white one is".

31 tests across test/plantRoom.test.ts and test/roomResidency.test.ts. The geometry suite was
mutation-checked: unordered mirrored spans, unflipped wall sides, and a door that ignores mirroring
each fail exactly one test.

**Deferred, and why:** the room does not track vault activity, tend its own plants, or put the
resident to bed — all proposed, none asked for. It also does not let the resident come home on its own,
matching the user's one-way rule.

## Pass 31: climbing by kicking off the opposite wall (2026-08-15)

Two things, one a defect I had knowingly left and one the user's idea.

**Bounded the spot-order recursion.** `driveSpotOrder` re-entered itself when `chooseSpotPlan`
returned "drop", to pick the phase up in the same tick rather than idling for one. Nothing bounded
it. Flagged two passes ago and left because the repro did not hang, which is not a reason. Now
re-entered exactly once; a second pass costs one tick and a stack overflow costs the app.

**Vertical movement was unusable and the fix was already in the pack.** `ClimbWall` averages
0.64px/tick, so a thousand pixels takes a minute — the source of every "the order does nothing"
report. The user pointed out the pack has wall-to-wall jumping already, and it does:
`JumpFromLeftWall`/`JumpFromRightWall` are each a `Jumping` at the opposite wall followed by
`GrabWall`, and `JumpOnIELeftWall`/`RightWall` the same onto a pane's edge. Reading their *conditions*
rather than their names settles what they are: all four require the mascot to already be in the
bottom quarter (`|workArea.bottom - anchor.y| < height/4`) and all four target
`bottom - random*height/4`. They are low lateral hops, not ascents. So the move is the pack's;
aiming it upward is the invention, and `Jumping` at 20px/tick is thirty times `ClimbWall`.

A corridor is two walls facing each other across open space. `side` alone cannot tell you that — a
pane is an obstacle seen from outside and its left edge is approached from the left, while the
window is a container seen from inside and its left edge is approached from the right. `source`
distinguishes them. Rooms are excluded: their walls are hand-authored and mix both kinds (the shell
is a container, a bookshelf is an obstacle), and a room is a few hundred pixels tall anyway.

**The first attempt only solved half of it, and the probe is what showed that.** A wall-to-wall
*transfer* helps only when the route crosses to the other wall. Most of the time it does not: the
router picks whichever surface gets nearest the target, and that is usually the wall already being
held, so the step is a plain climb and stayed slow. Measured: the corridor case still took 1509
ticks. So a climb along a wall that has a partner is now *costed* at kicking speed (Routing's
`climbSpeed`) and *executed* as kicks (BehaviorAI's `effectiveVia`), with the alternation falling
out of re-planning rather than being scripted. Plan and execution read the same `facingWall`, which
is why they cannot disagree.

Measured on the user's real layout, floor to the top of the panes: **91.5s → 13.3s**. Across the
window to the far top corner: 87.4s → 15.0s.

Tiled themes get nothing: neighbouring panes share their boundary exactly, and two coincident walls
are not a corridor. `minChimneyGap` rejects them rather than have a mascot flicker upward on the
spot. Card themes — which is what prompted all of this — leave 3-6px everywhere.

408 tests.

## Pass 32: the office, corrected against a screenshot (2026-08-15)

Four reports, one of which explained another.

**The resident was invisible behind the desk, and the cause was not the desk.** `MAX_RESIDENT_SCALE`
is 1 — never enlarge a mascot past its natural size, since one bigger indoors than out looks wrong at
the threshold. But the office is a room nothing ever leaves through that threshold in view, and the
cap silently overrode `residentHeightFraction`: a 128px sprite in an 860px-tall room is 15%, not the
30% asked for. Worse, it bound only in *wide* panes, so how much cleared the desk depended on how the
sidebar happened to be dragged. Now `residentMaxScale` is per-room and set high enough here that it
never binds, the seat is a chair at y=47 rather than the ground at 56, and a test walks five pane
widths requiring the proportion to vary by under 5%. Mutation-checked: restoring the cap to 1 fails it.

**The mascot shook.** Held to one behaviour now (`residentBehavior`, re-applied whenever the pack's
chain moves off it). In a room the size of a seat the pack's full repertoire — walks, stands, looks —
reads as jitter rather than idling. The pack's own `SitDown` wraps its `Sit` pose, so nothing was
invented for it.

**The monitor faced the wrong way.** The mascot faces the viewer across the desk, which puts the
screen's *back* to us — case, vents, cable, and stickers. Drawing the screen put viewer and mascot on
the same side of it. The stickers are deliberately the brightest thing on that side of the desk: a
blank grey rectangle facing the viewer is what the first version got wrong.

**Post-apocalyptic.** Whole palette moved into a narrow band of cold desaturated green-grey — damp
concrete, plaster gone to brick, moss and vines coming in through a broken pane, rubble — so that the
two warm things left, the lamp and the screen-glow leaking round the monitor, carry the picture. A
`gloom` wash is painted last, on the foreground layer, so it lies over the resident too: gloom is in
the air of the room, not behind the things in it.

410 tests.

## Pass 33: the room's light moves, and the office is alive in it (2026-08-15)

**The day was a boolean.** `RoomMood` carried `dusk` and nothing else, so a room had two appearances
and flipped between them at 7pm. It is now a curve — `daylight` 0–1 and `warmth` −1..+1, interpolated
between eleven keyframes. The transitions are the point: the blue hour after sunset is *dim and cold*
and looks nothing like the equally dim sunset twenty minutes earlier, which one brightness value
cannot express. `dusk` survives as a derived convenience for the three rooms that only want the one
bit, with its threshold placed so their appearance is unchanged.

**Animation is opt-in, and free for rooms that decline.** `RoomDef.animated` puts a frame counter
into the redraw key, which turns "repaint when the pane moves" into "repaint ten times a second"
without either path knowing about the other. Both layers derive that counter identically — a
foreground on a different frame from its background would light the desk at one moment of the day
and the wall behind it at another. Ten frames a second on purpose: this is a full repaint of every
fixture, and a lamp failing at sixty reads as noise rather than as a failing lamp.

**Three things move in the office**, all driven from one `light()` function so the room has a single
lighting model rather than a `mood.dusk ?` in ten fixtures:
- the lamp flickers on three sines of unrelated period plus a rare near-dropout. One sine reads as a
  pulse — a lamp doing something rhythmic on purpose, rather than one about to fail;
- the screen glow breathes slowly and never goes out, being the only sign the machine still runs;
- dust drifts down the shaft of window light, in proportion to how much light there is to catch it.

Warmth is applied *scaled by daylight*: sunset is deeply amber, but the little light at 3am is not
warm, it is just little.

The cycle is only observable over a real day, which is no way to find out whether dawn looks right —
so there is a command that steps the clock in three-hour jumps and `shimejiDebug.roomHour(h)`, which
with no argument prints the whole day as a table and hands the room back to real time.

Mutation-checked: freezing the flicker, dropping `animated`, and flattening the curve back to a
boundary at 7pm each fail exactly one test.

418 tests.

## Pass 34: the title bar, a third time — cold start, and a wall gap Pass 13 never covered (2026-08-16)

Reported again after Passes 13/14 had it fixed and confirmed: the title bar unresponsive, the window
undraggable. Two distinct causes found this round, neither a regression of Pass 13/14's own fix (both
predate it, just not reliably triggered until now) — the honest framing from Pass 13 still applies:
nothing here is reproducible outside a real Obsidian window, and both fixes are shipped without live
confirmation.

**Cold start.** `Stage`'s first ledge/overlay computation runs from the plugin's own `onload()`,
which — on a genuine app launch, not a dev-reload of just this plugin — can run *before* Obsidian has
restored the saved window layout. `onLayoutReady` exists precisely for that gap, but nothing called
it: `getWorldTop()`'s two DOM signals (workspace container top, topmost tab-header row) could both
read as unset that early, computing a too-small (often zero) worldTop once, with nothing recomputing
it afterward unless the user happened to resize the window or change the pane layout. A plain
restored session with no such interaction kept the stage overlay's `top` — and so the title bar's own
drag region — wrong for the rest of that session. Fixed: `this.stage?.notifyLayoutChanged()` now runs
once inside `main.ts`'s existing `onLayoutReady` callback, when the real layout is guaranteed settled.

**The wall gap Pass 13 never covered.** Pass 13 (`withoutFloorsTooCloseToTop`) excluded any *floor*
within a mascot's own rendered height of worldTop, because a floor-standing pose is bottom-anchored
and its sprite extends upward from that anchor, past worldTop, into the chrome above — but that fix's
own doc comment scoped it to floors, reasoning only about ceiling-hang (anchored near the sprite's
top, extending *downward*, genuinely unaffected). It never considered wall-*climbing*: a climbing
pose grips the wall roughly mid-body, not at the sprite's own top edge, so it extends upward from its
anchor too — and nothing stopped a mascot climbing a wall (the window's own edge, or a pane's) from
reaching an anchor y all the way up to worldTop itself, since `computeLedgesFromRects` plants every
wall's own top end exactly there. Fixed: renamed to `withoutLedgesTooCloseToTop`, which now also
trims a wall ledge's climbable span to end `standingHeight` short of worldTop (dropping a wall
entirely if that leaves nothing to climb), the same buffer already used for floors.

610 tests.

## Pass 35: the title bar, a fourth time — a second full-viewport overlay nobody had looked at (2026-08-17)

Reported again after Pass 34: title bar still undraggable. This time the user was asked to actually
run the decisive test Pass 14 built for exactly this and never got a confirmed answer from
(`shimejiDebug.hideOverlay()`) instead of shipping another guess against `.shimeji-stage`/worldTop —
the same file/ledge code had already been re-read twice this session with nothing new found by
inspection alone, so another pass of that would only have repeated Pass 12-14's own mistake.

**Result, from the user's live console**: `hideOverlay()` — no change, title bar still undraggable.
Disabling the whole plugin — fixed it. That pair of facts rules out `.shimeji-stage` (and everything
inside it, every mascot included) outright: hiding that element hides its entire subtree, so if a
mascot or the stage's own box were the cause, hiding it would have been enough. Something *outside*
`.shimeji-stage` that only disabling the whole plugin removes is the real blocker.

**Root cause**: `SpeechBubbles` appends its own `.shimeji-speech-layer` — `position:fixed; inset:0`,
a second, completely independent full-viewport box — straight to `document.body`, never as a child of
`.shimeji-stage`. `RoomForeground`'s canvas is the only other element appended directly to
`document.body`, but it's sized and positioned to a specific pane's own live rect, which by
construction never extends above Obsidian's real tab-header row — not a suspect. The speech layer,
by contrast, was never given the `top: worldTop` treatment `.shimeji-stage` got in Pass 16 (only that
one element's box was ever re-topped; nothing else the plugin draws was), so it sat over the title
bar/tab-strip drag region *permanently*, blocking Electron's native `-webkit-app-region: drag`
hit-testing by mere geometric presence — the exact mechanism Pass 16 confirmed for `.shimeji-stage`
itself, just never checked for this second element. `shimejiDebug.hideOverlay()` only ever toggled
`.shimeji-stage`, so it could never have caught this even in earlier passes.

**Fixed**: `Stage` gained a public `getWorldTop()` (the existing private field, already read live by
each mascot's own dependency thunk). `SpeechBubbles.tick(mascots, worldTop)` now re-tops its layer
every frame the same way `Stage.recomputeLedges` re-tops its own — cheap (one style write) and
self-correcting if worldTop ever changes mid-session, no new change-notification plumbing needed.
`elementsAtTop()` now reports the speech layer's own box directly, alongside the stage overlay's, so
a future report doesn't require re-deriving this from scratch.

**Honest framing**: this is evidence-based, not yet live-confirmed — the user's own hideOverlay/
disable-plugin result is what pointed here, but nobody has yet reloaded with this exact fix and
confirmed the title bar drags again. Given this file's own history with this bug (four rounds
counting this one), that confirmation is load-bearing before calling it closed.

**Separately reported same round**: a custom Move action's frames (sliced via the "Set frames…"
wizard, Aug 16-17 work) sliced with velocity left at 0 still don't move after pulling the fix that
makes *new* slices inherit velocity (`findReferenceVelocity`). Not a bug in that fix — it only ever
changes what a fresh slice starts with; it has no way to reach back and rewrite a `CustomPoseSpec`
already written to `data.json` from before the fix existed. The direct fix for existing data is
manual: Advanced edit… → the action → each pose's own Velocity (x,y) field, already present and
editable. No code change accompanies this entry; it's recorded here so the "still broken" report
isn't mistaken for the same class of bug as the title bar above.

636 tests.
