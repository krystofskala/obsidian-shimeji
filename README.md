# Shimeji Desktop Mascot (for Obsidian)

An animated mascot that lives inside the Obsidian window — it walks, sits, falls, gets
dragged around, and climbs the window edges — skinned with your own Shimeji-ee-compatible
artwork. The *platform* is necessarily different from the original: Obsidian plugins run
sandboxed inside the app's own window, so unlike the original Shimeji-ee (which overlays your
whole screen and detects other OS windows natively via JNA), this mascot is confined to the
Obsidian window and reads Obsidian's own panes instead of a tracked external window. But the
*physics and behavior algorithms* are, wherever that platform difference doesn't force a
change, direct ports of the real engine's actual Java source (`com.group_finity.mascot.*`),
not reinventions — see "Ported directly from the real engine's source" below for specifics
and exactly where the two necessarily diverge. See `SOURCE_AUDIT.md` for the working, per-file
checklist that pass was tracked against — useful if you're picking this up to continue the audit
rather than just reading about the outcome.

## Status

### Ported directly from the real engine's source, not reinvented

A full pass through the actual Java source
([`logany20/shimeji-ee`](https://github.com/logany20/shimeji-ee/tree/master/src/com/group_finity/mascot),
a direct mirror of the engine this plugin's own bundled `actions.xml`/`behaviors.xml` target —
`Mascot.java`, `action/*.java`, `behavior/*.java`, `config/*.java`, `environment/*.java`), after
several rounds of physics that turned out to be invented approximations rather than the real
thing (see the drag section below for how that went wrong). Found and fixed:

- **Weighted behavior selection had a real bug**: a `NextBehavior` reference was being gated by
  *both* its own condition *and* the target's separate top-level `<Behavior Condition="...">` —
  but the real engine's `Configuration.buildBehavior()` never re-checks the top-level entry for
  a reference at all, only the reference's own (inherited-plus-own) condition. This made some
  real transitions unreachable whenever the target's top-level definition happened to be
  condition-gated in a way the reference site didn't share.
- **A mascot could freeze forever**: if a tick ever landed on a state where nothing was
  eligible (candidates empty, or all present ones weight-0), `pickNextBehavior` returned
  `undefined` and nothing happened — forever, since the next tick would hit the exact same
  state again. The real engine's `Configuration.buildBehavior()` has an explicit recovery for
  this: teleport to a random x, drop in from `screenTop - 256` (definitely off-screen, so it
  visibly falls into view), and force `Fall`. Ported exactly, replacing an invented "prefer
  Fall in the tiebreak" heuristic that only covered a narrower case than the real one.
- **A second, separate recovery** (`UserBehavior.next()`'s own bounds check): every tick, if a
  mascot has drifted entirely past the left/right/bottom edge, the real engine recovers the
  same way — random x, `screenTop - 256`, forced `Fall`. Added as a general defensive net.
- **`Fall` only ever ended by landing on a floor** — the real `Fall.hasNext()` checks
  `floor.isOn(pos) || wall.isOn(pos)`: touching a wall ends a fall too. Without this, falling
  into the side of a pane just clamped horizontally and kept falling straight past it, and the
  real Fall sequence's own `Select` step (`Bounce+Stand` if landed on a floor, `GrabWall`
  otherwise) could never actually reach the `GrabWall` branch from an ordinary fall.
- **`Fall` never updated facing** — real `Fall.tick()`: `if (velocityX != 0)
  setLookRight(velocityX > 0)`, every tick. Ours left facing at whatever it was before the fall
  started.
- **Resistance/gravity silently defaulted to zero/wrong instead of the real engine's own
  defaults** — `Fall.java`'s `getRegistanceX/Y()`/`getGravity()` fall back to real, nonzero
  constants (0.05 / 0.1 / 2) when the action's XML omits the attribute; ours defaulted to no
  resistance at all, and had `Fall` fall back to the pack-wide `config.gravity` instead of the
  real engine's own default of 2 (the real engine has no "pack-wide gravity" concept — every
  `Fall` reads only its own `Gravity` attribute).
- **`LostGroundException`, ported as a `lostGround` flag**: the real engine aborts a
  Wall/Ceiling-bordered `Move` immediately (straight to `Fall`) if its border vanishes
  mid-climb (a tracked window closing, in the original). Ours never checked, so a pane closing
  mid-climb left the mascot moving against a wall/ceiling that was no longer there. `tickMove`
  now re-validates and flags it; `BehaviorAI` consumes the flag and forces `Fall`, mirroring
  `UserBehavior.next()`'s own `catch (LostGroundException)`.
- **`weightedPick` simplified to match the real, much simpler algorithm**: a plain weighted
  roll (`random -= weight; if (random < 0) return`) with no special-casing — the "what if
  nothing has positive weight" question the old version tried to answer internally is now
  answered upstream, exactly where the real engine answers it (the respawn recovery above),
  not inside the picker itself.

**Deliberately not ported (documented, not silently skipped)**: `Fall.java`'s exact pixel-stepping
sub-tick collision loop (an 80px look-back "HACK IE" specifically for tunneling through a
*fast-moving tracked window* — our floors/walls are stable Obsidian panes, so the tunneling case
it guards against is far less likely to matter, and continuous per-tick checks already catch a
touch within the same tick); `Wall`/`FloorCeiling.move()`'s exact proportional-rescale-relative-
to-a-moving-border math (a resizing/moving *tracked window* redistributes a mascot's relative
position along it — ours just re-snaps to the nearest current ledge, see the resize-fall-through
fix below, a simpler approximation of the same intent); `Move.tick()`'s exact
target-overshoot timing (the real engine snaps position but still finishes the tick's own
duration bookkeeping normally, only ending on the *next* `hasNext()` check — ours ends the frame
immediately on overshoot, a minor animation-completeness difference, not a position error).
(An earlier version of this section also listed "ChaseMouse's real trigger cadence" as an
unresolved approximation — that one turned out to be findable after all, see the fifth pass
below: it has no autonomous trigger at all, so there was never a cadence to match.)

**A second pass, going past the pieces that had visible bugs into the rest of the source**
(`action/Look.java`, `action/Jump.java`, `action/Breed.java`, and `BorderedAction`/
`UserBehavior.next()`'s `LostGroundException` handling) turned up four more real divergences:

- **`Look` had the wrong default entirely**: ours picked `LookRight` by comparing the mascot to
  the ambient pointer ("face the cursor") whenever a `<Look/>` step omitted the attribute. The
  real `Look.apply()` is `setLookRight(eval("LookRight", Boolean.class,
  !mascot.isLookRight()))` — the default is *toggle whichever way I'm currently facing*, nothing
  to do with the cursor. Scripted sequences place a bare `<Look/>` between segments specifically
  to rely on that toggle for their own authored turns (e.g. `ClimbAlongWall` switching from
  climbing up to moving along the ceiling); with the invented cursor-facing default, that turn
  silently did nothing whenever the mascot already happened to be facing the cursor's side.
- **`Jump` was a reinvented ballistic arc, not the real algorithm**: ours gave it one initial
  velocity, same as `Fall`, and let gravity take over. The real `Jump.java` isn't gravity-driven
  at all — every tick it recomputes a fresh vector straight at the target (`dx = targetX - x;
  dy = targetY - y - abs(dx) / 2`; that `-abs(dx)/2` term fakes an arc shape with a fixed
  vertical bias, not real gravity) and moves at a constant speed along it, snapping exactly onto
  the target once within one step's distance. Ported as `tickJump`, now called every tick with
  the live `TargetX`/`TargetY` locals (previously only read once, as a start effect, so the
  target could never track anything moving) and `VelocityParam` (default 20).
- **`Breed` had three real gaps**: `BornX` never flipped sign with facing, so a pack authored
  assuming "spawn slightly behind me" (`lookRight ? x - BornX : x + BornX` in the real
  `breed()`) spawned every sibling on a fixed screen side regardless of which way the parent was
  actually facing. The sibling never inherited the parent's current facing
  (`setLookRight(getMascot().isLookRight())` in the same method) so it always started at the
  engine's default instead. And breeding fired the instant the behavior started rather than
  `getTime() == getAnimation().getDuration() - 1` — one tick before the whole birth animation
  finishes — so the sibling used to appear before its parent had even finished playing the birth
  pose.
- **The `LostGroundException` recovery from the first pass only covered `Move`**: the real
  `BorderedAction` base class behind `Move`, `Stay`, *and* `Animate` checks
  `getBorder().isOn(anchor)` identically in all three, so a `Stay`/`Animate` step glued to a
  wall or ceiling (e.g. `GrabWall`'s own `Stay`) can lose its border and should fall exactly
  like a climbing `Move` can — only `tickMove` had the check. `tickHold` (the `Stay`/`Animate`
  path) now shares the same check, run *before* advancing the pose rather than after, matching
  the real check-then-tick order.

Also confirmed, while reading `Regist.java` (`Resisting`, nested inside `Dragged`) for the above:
it has its own `hasNext()` (ends once the cursor moves more than 5px from the drag anchor) and
throws `LostGroundException` into a forced `Fall` once its own animation completes while the
cursor still hasn't moved. Left unported — this engine renders Dragged/Pinched/Resisting through
a separate live-preview path (`PackDriver.renderState`) that doesn't run the action interpreter
during an actual drag at all, so neither mechanic has a tick loop to hook into without a
structural change to how dragging is rendered. `Resisting` stays effectively unreachable, same
as before this pass — a documented gap, not a new one.

**A third pass, going systematically file-by-file through the entire real source tree** (not just
the pieces already touched — see `SOURCE_AUDIT.md` for the full per-file checklist this was
tracked against) turned up the single largest bug found so far:

- **Every multi-Pose `Stay`/`Animate` action was silently self-ending after one pass through its
  poses, ignoring any `Duration` override that was supposed to make it hold or cycle for
  longer.** The previous `tickHold` walked a `poseIndex` forward and stopped the instant it ran
  off the end of the array unless the action's XML had `Loop="true"` — but real packs *never* put
  `Loop=` on a `Stay`/`Animate` action (it's exclusively a `Sequence` concept, confirmed via a
  full-pack grep), so that check was always false and every multi-Pose hold ended after one
  linear pass no matter what `Duration` said. The real engine's rule (`ActionBase.hasNext()`:
  `time < Duration`, `Animate` adds `time < animation.getDuration()` on top; `Animation` itself
  always cycles by `time % totalDuration`) ties *termination* to elapsed time, completely
  decoupled from how many poses got shown. The real pack's own `SitAndDangleLegs` (4 poses,
  ~1.6s combined) is referenced with `Duration="500-600"` (20-24 seconds) expecting to cycle
  those 4 poses on a loop for the whole stretch — the old code played them once and moved on,
  roughly a 12-15x undershoot. `tickHold` now tracks total elapsed time and reuses the same
  `pickLoopingPose` modulo-cycling helper `tickEmbedded` already used, instead of a one-shot
  `poseIndex` walk.
- **`ThrowIE` was mapped to plain `Fall`, alongside `FallWithIE`, which was wrong**: unlike
  `FallWithIE` (which really does extend `Fall`), `ThrowIE.java` extends `Animate` — its own
  `tick()` never touches the mascot's position at all (`BorderType="Floor"`, a single
  `Velocity="0,0"` pose); in the real engine it only throws the *tracked window* out from under a
  mascot that stays put. Mapping it to `Fall` ran real falling physics on the mascot, which
  immediately "landed" again since it was already standing on the floor, cutting the held "threw
  it" pose short instead of holding it for its full duration. Now routed through `tickHold` like
  `Regist`, holding in place like the real class hierarchy says it should.

**A fourth pass through `script/`** — the real `#{...}`/`${...}` expression evaluator, the one
remaining subsystem that had never been checked against source (`Expression.ts` was originally
built from *observed patterns* in the XML rather than a source read) — found that the two
wrappers aren't just stylistic. Real conditions/values are compiled and run as actual JavaScript
(`Script.java`, via the JVM's own script engine), and `#{...}` re-evaluates fresh every tick while
`${...}` evaluates once and caches for the rest of the action's lifetime — a distinction our own
code had explicitly (and wrongly) written off as not mattering in practice. It didn't matter for
ActionReference parameters (Duration, TargetX, BornX, ...), which our engine already only
resolves once per action-start regardless of wrapper syntax — but it did matter for **which
Animation variant is showing**: the real `ActionBase.getAnimation()` re-picks the effective
(condition-true) variant fresh every tick, so an Animation-selection condition tied to live state
can swap poses mid-action without restarting it. The real pack's `SitAndLookAtMouse` does exactly
this — it picks "looking up" vs "looking down" by live cursor position, held for several hundred
milliseconds, long enough for the mouse to cross the threshold mid-hold. Our `chooseAnimation` was
only ever called once, at push time. Fixed by re-running it every tick in `tickHold`/`tickBreed`/
`tickEmbedded` (`tickMove` deliberately keeps its one-time selection — see its own comment for
why: no real pack's multi-variant `Move` needs live re-selection, and splicing mid-gait-cycle has
no obviously-correct answer).

**A fifth pass, prompted by a direct question — "if anything's still synthesized instead of a
real port, go rewrite it"** — went back through every remaining place the code admitted to
*guessing* rather than *knowing*, and found exactly one: a comment in `BehaviorAI.ts` next to
ChaseMouse's trigger logic, saying outright that there was "no ground truth available" for its
real cadence and that the periodic-cooldown eligibility there was an approximation. Rather than
leave that as accepted, went back to `Main.java` — which an earlier pass had written off entirely
as "Java-desktop-only, out of scope," itself a mistake — and found the actual mechanism:
**ChaseMouse has no autonomous trigger in the real engine at all.** It's exclusively bound to a
"Follow Mouse!" system-tray menu item (`getManager().setBehaviorAll("ChaseMouse")`), which forces
*every* mascot onto it at once, on demand — the same kind of manual, all-mascots command as
"Another One!"/"Reduce to One!" (both already ported faithfully as menu items, which is what made
the inconsistency worth chasing). The invented periodic/cooldown eligibility has been removed
entirely; a "Make all Shimejis follow the mouse" command and context-menu item now does the real
thing, forcing every mascot straight onto its pack's ChaseMouse behavior — the same primitive the
existing per-mascot "Set behavior" menu already used for one mascot at a time.

**A sixth pass finished reading the handful of files this tracker still had marked "not yet
audited"** (`environment/{Area,ComplexArea,Location,Environment}.java`, `config/Entry.java`) and
turned up the second-largest bug of the whole audit. `Location.java`'s `set()` — `dx = (dx +
(newX-x)) / 2`, an exponential smoothing of the raw per-tick cursor delta — **is**
`mascot.environment.cursor.dx/dy`, and the real pack's `Thrown` action reads it *directly* as its
release velocity (`InitialVX="${mascot.environment.cursor.dx}"`). Drag release here computed a
completely unrelated windowed average of the *drag's own* recent pointer samples, with a
`dragThrowScale` tuning constant the real engine has no equivalent of at all — replaced with a
faithful port of the real smoothing formula, computed once per fixed simulation tick against the
same ambient cursor tracker `cursor.x/y` and ChaseMouse already use, rather than a second,
independently-sampled one. The same file also settled something adjacent: real
`UserBehavior.mouseReleased()` unconditionally forces the `Thrown` behavior — there's no speed
threshold in the original at all — while this plugin branched between forcing "Fall" or "Thrown"
by comparing release speed against a tunable minimum. Releasing a drag now always forces `Thrown`,
matching the real engine exactly; the *native fallback* placeholder (which has no real engine
counterpart to be faithful to in the first place) keeps its own simpler two-state distinction for
its own visual variety. Getting this right surfaced one more thing worth calling out: applying the
fix correctly required *not* pre-converting the cursor velocity to pixels-per-second the way
everything else in the engine's own physics is expressed — pack-authored per-tick quantities
(Velocity, Gravity, a Fall's InitialVX/VY, ...) flow through the condition/expression system in
their original tick units and only become pixels-per-second at each one's own point of
consumption, so the runtime-computed cursor velocity has to follow the identical convention or it
gets converted twice.

**A seventh pass, prompted by another direct challenge — "is every file actually checked, file by
file?"** — read every remaining file that had only ever been categorized by name and role and
never actually opened: the Swing character-picker dialog, the AWT image-loading/mirroring
classes, the JNA/OS-native dispatch factory, logging setup, and the rest of `Main.java` beyond the
tray-menu section an earlier pass had already read. Nearly all of it confirmed exactly as
expected — pure GUI/logging plumbing with no mascot-behavior logic hiding inside, the same shape
as everything the fifth pass's `Main.java` scare had already trained suspicion on. But the rest of
`Main.java` turned up one more real bug: `createMascot()` creates every new mascot off-screen at a
fixed anchor, `(-1000,-1000)` — nowhere near any real on-screen position. What actually puts a
freshly spawned mascot somewhere visible is `UserBehavior.next()`'s off-screen-bounds recovery,
firing on the very next tick: relocate to a random x, drop it in from just above the top of the
screen, force `Fall`. This plugin had already ported that exact mechanism faithfully — but only
for its role as a *recovery* path (a mascot that drifts entirely off-screen mid-behavior), without
recognizing it doubles as the *only* real spawn mechanism there is. There is no such thing, in the
real engine, as a mascot that simply appears already standing in view — every one of them is
falling in from off the top of the screen at a random x, every time. Spawning here instead dropped
a new mascot in already inside the window, horizontally centered, at a fixed height chosen purely
so it wouldn't look clipped — a reasonable-sounding invented default, picked before this file had
ever been read in full. A manual spawn (the command, the "Add another Shimeji" menu item,
auto-spawn-on-load) now falls in from off-screen exactly like the original; Breed/duplicate, which
always specify their own exact parent-relative position, are unaffected. With this file-by-file
sweep done, every file in the real engine's source tree has now actually been opened and read —
Swing/AWT/JNA GUI plumbing included, not just the core simulation subset.

- **A real `actions.xml`/`behaviors.xml` interpreter**, verified directly against the actual
  standard shimeji-ee conf files (checked into `Shimeji/conf/`) — Sequence/Select/Animate/
  Move/Embedded actions, condition-gated Animation variants (e.g. ClimbWall's up-vs-down
  poses), `TargetX`/`TargetY`-driven walking, the `#{...}`/`${...}` condition language
  including the `mascot.environment.floor.isOn(...)`-style predicate API almost every
  standard behavior is gated on, and weighted random behavior selection with the
  additive/exclusive `NextBehavior` semantics real packs rely on.
- **Ticks/units matter**: shimeji-ee's own engine runs a fixed 40ms-tick loop, and
  Duration/Velocity/InitialVX/VY in actions.xml are all in *ticks*, not real time — converted
  once at parse time (`src/shimeji/constants.ts`) so the rest of the engine works in plain ms
  and px/second.
- **Physics glue that isn't in the XML at all, but the pack's own design assumes it**:
  Floor-bordered actions (Stand/Walk/Sit/...) are kept glued to whatever floor is actually
  beneath them — falling to reach it if needed — because real transitions like
  `FallFromWall` are just a 1px `Offset` then a plain `Stand`, with no explicit falling step;
  that only works if the engine treats "on the floor" as a continuously-enforced background
  state, not something each action has to arrange itself. Wall/Ceiling-bordered actions
  (ClimbWall, ...) correctly clear that floor-grounded state instead of leaving it stale.
  Fall/Thrown also now respect the window's side walls *and* ceiling (originally only the
  floor was checked, so a hard throw could sail off the edge or through the top into
  permanent invisible freefall), and apply the Falling action's own `Gravity`/`RegistanceX`/
  `RegistanceY` instead of one constant global gravity with no air drag.
- **Behaviors the engine triggers directly, not through weighted selection**: `Fall` (physics
  event), `Dragged`/`Thrown` (mouse input), and `ChaseMouse` — declared `Frequency="0"` like the
  other three and never referenced by any other behavior's `NextBehavior`, so it's orphaned from
  the weighted-pool graph entirely in the real pack, same as them. Unlike the other three,
  though, its real trigger isn't physics or mouse input at all: it's a "Follow Mouse!"
  system-tray menu item (`Main.java`: `getManager().setBehaviorAll("ChaseMouse")`), forcing
  every mascot onto it at once, on demand — no autonomous/spontaneous trigger exists in the real
  engine. The "Make all Shimejis follow the mouse" command and context-menu item are that,
  faithfully; see the fifth audit pass below for how an earlier, invented periodic-cooldown
  approximation here got replaced.
- **Approximated, not literal**: the original engine tracks a specific external OS window
  ("activeIE" in its own naming, from its IE-integration history) that mascots can climb on;
  here that concept maps to whichever open pane the mascot is currently against — its top,
  either side, or its underside all count, matching a real pane's full bounding box (see the
  next point). The status bar only ever contributes a floor, not a climbable rect, since it's
  a thin strip rather than a tracked "window."
- **A pane's sides and underside are climbable too, not just its top**: auditing the real
  files for this turned up an entire category of authored behaviors —
  `HoldOntoIEWall`/`ClimbIEWall` (a pane's side), `ClimbIEBottom`/`GrabIEBottomLeftWall`/
  `GrabIEBottomRightWall` (hanging off its underside), plus pane-aware variants of
  `HoldOntoWall`/`FallFromWall`/`HoldOntoCeiling`/`FallFromCeiling` — that reference
  `mascot.environment.activeIE.leftBorder`/`rightBorder`/`bottomBorder.isOn(...)`, which were
  all hardcoded to `false`, so none of them could ever be selected. `computeLedgesFromRects`
  now emits wall/ceiling ledges for a pane's own left/right/bottom edges (not just its top as a
  floor), each carrying a back-reference to that pane's full rect so `activeIE.left/right/top/
  bottom/width/height` all resolve consistently to whichever *one* pane the mascot is
  currently against — floor takes precedence, then wall, then ceiling. A new
  `updateWallCeilingAdherence` keeps `currentWall`/`currentCeiling` fresh every tick,
  unconditionally (mirroring how gravity already keeps `currentFloor` fresh), since a mascot
  can end up against a wall from simply walking into one during an ordinary Floor-bordered
  action — it can't be limited to only running during an already-Wall/Ceiling-bordered action,
  or the condition that triggers climbing in the first place could never become true.
- **Real multiple mascots, including real `Breed`**: `Stage` now runs any number of
  independent mascots (capped by a settings limit) instead of just one. A pack's own Breed
  actions (`PullUpShimeji1`/`Divide1` in the real pack, verified against the actual XML) spawn
  a genuinely new sibling mascot offset by `BornX`/`BornY`, started directly on
  `BornBehavior` — bypassing weighted selection entirely, the same way Fall/Dragged/Thrown/
  ChaseMouse do, since `PullUp`/`Divided` are `Frequency="0"` and never any other behavior's
  `NextBehavior` target either. `mascot.totalCount` (the real pack gates breeding on
  `totalCount < 50`) now reflects the actual live mascot count instead of always being 1.
- **The simulation core no longer touches `window`/`document` directly**: `Stage`/`Mascot`/
  `BehaviorAI` go through an injectable `Environment` interface for viewport size and
  platform-ledge geometry, and `Stage`'s loop is a fixed-timestep accumulator at the same
  40ms tick the original engine itself runs, instead of scaling behavior speed with whatever
  the display's framerate happens to be.
- **Settings and a right-click menu roughly matching shimeji-ee's own preferences**: which
  characters are active (multiple at once — each spawn picks one at random), max mascots on
  screen, auto-spawn count, allow dragging, allow breeding, and chase-the-mouse are all
  settings now, alongside the original size/pane-ledges/debug-ledges controls. Right-clicking
  a mascot opens a menu to switch its character, jump it to a specific behavior, duplicate or
  remove it, remove everyone, or add another.
- **Settings-based authoring, not just XML editing**: the character editor (Settings → pick a
  character → **Edit...**) adds or overrides a character's own actions and behaviors — poses,
  Sequence/Select steps, Embedded handlers (Fall/Breed/Regist/Look/Jump/Offset/Dragged), and
  behavior transitions — without touching `actions.xml`/`behaviors.xml`
  directly. A custom entry with the same name as a standard one replaces it, and it's built
  into the exact same `ActionDef`/`BehaviorDef` shape the real XML parser produces (see
  `CustomContentBuilder`), so it runs through the identical interpreter rather than a separate
  code path. Auditing the real schema for this surfaced a small interpreter gap, now fixed: an
  unrecognized `Regist` embedded class (the real pack's struggle animation nested inside
  `Dragged`) was falling back to gravity instead of just holding its pose in place. (`Jump` was
  also flagged here as unrecognized at the time; that's fixed too, but as part of the physics
  rewrite below, not this interpreter-recognition pass — see the second audit pass above.)
- **Mobile**: dragging is already built on Pointer Events, which cover touch, and pack loading
  already goes through the cross-platform vault adapter API rather than Node's `fs`, so most
  of this needed no changes. The one real gap — no right-click on a touchscreen — is closed
  with a long-press: holding a mascot still opens its context menu the same way Obsidian's own
  mobile UI already uses touch-and-hold elsewhere, while an actual drag (the pointer moving
  before the hold fires) is unaffected and still starts immediately, matching desktop.
  `touch-action: none` and `-webkit-touch-callout: none` stop the browser's own scroll/pan
  gesture recognition and iOS's image-callout from competing with either gesture. ChaseMouse
  is force-disabled on `Platform.isMobile` regardless of its own setting — there's no ambient
  pointer between touches for it to dash toward, so it would just be heading for a stale,
  meaningless position; the setting itself is untouched and still applies normally if the same
  vault is later opened on desktop. Untested on a real device so far — the timer/event-lifecycle
  wiring here specifically couldn't be covered by the test suite (this repo's jsdom has no
  `PointerEvent`/`setPointerCapture` at
  all), unlike the drag mechanics below, which do have regression tests.
- **Fixed a real "fall through the floor" bug**: the check for "is the floor I'm standing on
  still there" only accepted a floor at-or-below the mascot's current position
  (`findFloorBelow`) — correct for catching an active fall, but wrong for re-validating an
  already-grounded mascot after the ledges change. Shrinking the Obsidian window (dragging its
  bottom edge up) moves the floor *up* past a mascot standing near the old bottom edge, so
  nothing qualified as "below" its stale position anymore and it fell through and kept falling
  forever, off-screen. `findNearestFloorAt` (direction-agnostic — closest floor at this x,
  above or below) is now used specifically for that re-validation, so a grounded mascot
  re-anchors to wherever its floor actually is now instead of falling through it.
- **Live console diagnostics** (`window.shimejiDebug` in Obsidian's DevTools console) for
  issues that are easy to trigger interactively but hard to reproduce blind:
  `stageCount()` (catches a leaked `Stage` instance from a previous reload still running
  alongside a fresh one), `hideOverlay()`/`showOverlay()` (toggles the full-window overlay live,
  to test whether its mere DOM presence — not just its own CSS — interferes with the OS
  title-bar drag), `elementsAtTop()` (what `document.elementFromPoint` actually finds along the
  top edge, including computed `pointer-events`/`-webkit-app-region`), `mascotRects()` (every
  live mascot's current bounding box, to catch one sitting over the title bar mid
  ceiling-walk), `dumpLedges()` (every currently-computed floor/wall/ceiling, for "why did it
  land/climb there" reports), and `setVerbose(true)` (a live trace of every landing and every
  behavior transition, tagged `[obsidian-shimeji]`, for chasing a specific "drop from height did
  something odd" repro). Four rounds of live testing (this tooling didn't reproduce any of it
  blind — every one of these needed a real Obsidian window) turned up a cluster of real,
  distinct bugs around the plugin's Obsidian-specific boundary, now all fixed:
  - The window's own ceiling/walls used to be anchored at the literal top of the app's viewport,
    so wall-climbing and ceiling-walking (both authentic behaviors) could carry a mascot onto the
    title bar/tab strip itself, and — confirmed directly from a user's own console, not assumed —
    that overlap is *also* what was blocking the title bar from being dragged, not the overlay
    itself. The fix first tried anchoring to `app.workspace.containerEl`'s own top, which works
    when the title bar is a separate element above the workspace — but Obsidian can also merge the
    tab strip into the same row as the window's minimize/maximize/close buttons, in which case
    `containerEl` itself starts at literal y=0 and that fix does nothing. `getWorldTop()` now also
    measures the real tab-header row directly (`.workspace-tab-header-container`, confirmed via
    console to be the actual element carrying the OS drag region) and uses whichever of the two
    signals excludes more. A mascot standing on a floor that's still legitimately close to that
    line no longer settles somewhere its own sprite height would poke back into the chrome either,
    since floor-standing poses are anchored at the feet.
  - A drag release could skip the fall animation entirely and teleport the mascot somewhere
    unrelated to the release point. Contributing causes, in the order they were found and fixed:
    the shared ambient-cursor tracker (used for both ChaseMouse and a released mascot's throw
    velocity) went stale for the whole drag, because it listened for `mousemove`, which the
    mascot's own `preventDefault()`-on-`pointerdown` handler suppresses for the rest of that
    interaction; and — the actual dominant cause — a released mascot's horizontal screen-edge
    containment shared its range with the *new* ceiling boundary above, leaving a gap right above
    it that let `physics.x` drift past the edge and trip an unrelated "mascot got lost off-screen"
    recovery, which resets position with no animation at all.
  - Even past that, a drop still wouldn't visibly fall — it clung to a wall instead. The
    screen-edge/pane-wall safety clamp can pin a mascot's position exactly onto a wall, and the
    fall's own wall-catch check ran immediately after on the same tick, so a position the clamp
    had just corrected always read as "just flew into a wall." A drag release starts pinned to
    whatever wall it was dragged up against, so the very first falling tick "caught" it instantly.
    Fixed by only counting it as a genuine catch when the mascot's own movement that same tick is
    what brought it into reach, not merely being left resting there from an earlier correction.
  - Separately: a real typo in the bundled reference pack's own `actions.xml` (`ClimbCeiling`/
    `Walk`'s `TargetX`, one branch of a ternary missing the call parens the other has —
    `Math.random*100` instead of `Math.random()*100`) meant a bare, uncalled `Math.random`
    silently resolved to a fixed `0` instead of warning loudly, turning a randomized walk/climb
    target into an exact, deterministic one whenever facing that direction. And separately again:
    `window.shimejiDebug.setVerbose(true)`'s trace used `console.debug()`, which Chromium hides
    under DevTools' default console filter — verbose logging had likely been silently producing
    zero visible output for every user who ever turned it on. Both fixed.

  See `SOURCE_AUDIT.md` Passes 11-16 for the full, honest blow-by-blow — including rounds where a
  fix landed, looked complete, and turned out to have missed the actual dominant cause entirely.
- **Drag is now a direct port of the real engine's own `Dragged.java`, not an invented
  approximation**: several rounds of home-grown drag heuristics here (a critically-damped
  spring for position, then an extrapolated-cursor "lean pointer", then exponential smoothing
  on top of that) each fixed one symptom while introducing another — culminating in a drag
  that consistently leaned toward one side regardless of which way it was actually pulled.
  Pulling the actual source
  ([`Dragged.java`](https://github.com/logany20/shimeji-ee/blob/master/src/com/group_finity/mascot/action/Dragged.java),
  the Java class the real pack's `Pinched` action names as its `Class`) showed the real
  mechanism is simpler than any of that and not what was being approximated:
    - **Position has no lag or lerp at all**: every tick, the anchor is set to exactly
      `(cursor.x, cursor.y + 120)` — a fixed offset below the cursor (holding the sprite by the
      scruff of the neck, not by whatever pixel you clicked), snapped instantly, every time.
      There's no spring constant to tune because the original doesn't have one.
    - **The swing/lean effect is a *separate* variable, not derived from the position at
      all**: a `FootX` value trails the cursor via `footDx = (footDx + (cursor.x - footX) *
      0.1) * 0.8; footX += footDx` — a small, specific recurrence, run once per tick — and it's
      *that* lagging value, compared against the live (unlagged) cursor.x, that the real
      Pinched action's five poses are conditioned on. `tickDragFootX` ports this formula
      exactly (regression tests assert hand-computed values tick-for-tick, not just "looks
      plausible").
    - **`lookRight` (facing) is forced `false` unconditionally, every tick, for the entire
      drag** — the mascot never mirrors while being dragged, full stop, because the five
      Pinched images already encode their own left/right and mirroring on top of them was
      exactly the "always leans one side" bug.
  All of the invented machinery this replaced — a spring-based `tickDragged`, the
  velocity-extrapolating `computeLeanPointer`, and the `smoothSwing` damping added on top of
  that — is gone; there's nothing left to smooth once the lag lives in the same place the
  original puts it.
- **Not visually tested in a live Obsidian window** — this was built in a headless
  container with no GUI; every fix so far has been verified via `tsc`/`vitest`/`esbuild` plus
  tests that exercise the real conf files in `Shimeji/conf/` directly (not just synthetic
  fixtures), including one that drives a full BehaviorAI simulation from a fresh spawn and
  DOM-level smoke tests that construct a real `Mascot` in jsdom and check its rendered
  transform/visibility. That catches logic bugs but not "does this look/feel right" —
  pane/status-bar ledge geometry, drag feel, and animation timing are exactly the kind of
  thing that needs a real window to tune, so please keep reporting anything that looks or
  feels off.

### Newer engine features (v1.0.13 – v1.0.22)

The audit above was done against
[`logany20/shimeji-ee`](https://github.com/logany20/shimeji-ee), which is frozen at roughly
v1.0.12. Ground truth has since moved to
[`DalekCraft2/Shimeji-Desktop`](https://github.com/DalekCraft2/Shimeji-Desktop) (Kilkakon's line,
through v1.0.22) — see `SOURCE_AUDIT.md` for the commit table and the per-feature notes. Ported
from it:

- **`SelfDestruct`** (v1.0.13) — a purely time-based action that removes the mascot when its
  animation ends. Combined with `BornTransient`, this is the mechanism behind effects like a
  mascot firing a projectile: the projectile is just another mascot set to self-destruct.
- **`BornMascot` / `BornTransient` / `BornInterval` / `BornCount`** — `Breed` can spawn a
  *different* character, mark the clone as transient (gated by its own setting, separate from
  breeding), spawn on an interval, and spawn several at once.
- **`BreedMove` / `BreedJump`** (v1.0.18) — ordinary Move/Jump that additionally breed on an
  interval for as long as they run.
- **Affordances + `ScanMove`** (v1.0.14) and **`ScanInteract`** (v1.0.21) — mascots advertise an
  affordance string and can seek out (or interact in place with) whichever other mascot is
  currently broadcasting the one they're looking for, redirecting both on contact.
- **`Mascot.getCount()` vs `getTotalCount()`** (v1.0.16) — "how many of *me*" as distinct from
  "how many mascots at all".
- **Per-action `Draggable`** (v1.0.13) and **`Toggleable` behaviors** (v1.0.21) — a pack can make
  specific actions un-grabbable, and mark behaviors the user may switch off permanently from the
  mascot's own menu.
- **Exposed physics variables** (v1.0.21) — `VelocityX`/`VelocityY`/`TargetX`/`TargetY`, readable
  from inside the same action's own Animation conditions.
- **`Hotspot`** (v1.0.19) — clickable regions on a pose that run a named behavior instead of
  starting a drag, refreshed every tick from whichever Animation variant is currently effective.
- **Shimeji Variables** (v1.0.22) — `mascot.variables['name']`, arbitrary per-mascot state a pack
  owns outright and keeps for the mascot's whole life. Needed bracket indexing and assignment in
  the expression evaluator, which is now supported.
- **Sound** (v1.0.9 / v1.0.16) — per-`<Pose>` `Sound`/`Volume` and the `Mute` action. See the
  "Sound" section under *Using your own artwork*; it's off by default.

## Using your own artwork

### The character editor

The one place to build and edit a character: **Settings → Shimeji Desktop Mascot →
Characters → Your characters → Create...** for a brand new one, or **Edit...** next to an
existing one — the same modal either way, since editing is just resuming where creating left off.

A new name gets shimeji-ee's full standard behavior repertoire immediately — walking, sitting,
climbing, breeding, all of it — as a real, resolvable character with no art yet. What follows is a
checklist of exactly the pose images it still needs: around 42 of them, not the ~90-odd `<Action>`
entries the real schema defines, since most of those are pure choreography reusing a handful of
images rather than each needing art of their own. Window-throwing's four images are shown too, in
their own collapsed, optional group — skippable entirely if you leave window-throwing off, which
it is by default.

Click any pose to fit an image to it, in any order, and come back to unfinished ones any time —
nothing about the checklist is saved anywhere of its own, it's recomputed from what's actually in
the folder each time the editor opens. Three ways to get an image into the frame:

- **Upload a photo** — never written to your vault on its own, only whatever you end up saving.
- **Pick an image already in this pack**, if you've uploaded one for another pose already.
- **Slice from a sprite sheet** — opens the same sheet-cutting tool described below, against a
  sheet you upload right there (which *is* kept in the pack folder afterward, so you can come
  back and cut it differently later).

**Flip** (horizontal/vertical) and **rotate** (90° either way) fix orientation — a source photo
facing the wrong way, or turned on its side — applied to the image immediately, undone by doing
the same thing again (flip is its own inverse; rotating four times the same way is a no-op).
Drag to position the image, scroll (or the on-screen buttons) to zoom — there's no separate crop
step, since whatever falls outside the fixed 128×128 frame at Save is simply left out. A red
crosshair (sometimes two, for the handful of images the real schema anchors differently depending
on which action is using them) marks where the standard schema expects that pose's own reference
point to land, straight out of the real `actions.xml` — not something the editor invents or lets
you override, since the copied schema already carries the real value for every pose, unmodified.

If a folder of **reference art** is set (**Settings → ... → Reference art for the character
wizard**), whichever image shares the slot's own filename shows underneath the one you're fitting,
at reduced opacity, so you can match proportions and silhouette by eye. This plugin never ships
that art itself, the same way it ships no character art at all — you'd need to supply your own
copy, of the original or of any other character whose proportions you want to match. A slot with
nothing there just shows a plain frame with no guide; nothing about the editor depends on it.

Creating a *second* character reorganizes the pack folder from the single-character layout into
the multi-character one described below, if it isn't already — you'll be asked to confirm first,
and nothing is ever deleted, only moved.

Below the pose checklist, the same modal has everything **Actions**, **Behaviors**, and **Images**
need — no separate editor, no separate settings section to hunt for it in, and no forced choice up
front between "classic single shimeji images" and "sprite-sheet character": both stay available for
every action, always, so a character can freely mix the two.

**Actions** lists every action that owns pose art of its own — required, then window-throwing's
four tucked into a collapsed group, the same split the pose checklist itself uses. Two ways in, on
every row:

- **Set frames…** is normally all you need: pick or slice images for it and you're done. This is
  also the way to give a game-sprite-sheet character several frames for something the standard
  schema treats as one static image — walking, standing, anything — instead of forcing it into a
  single picture. The first time, whatever the action currently plays becomes "Option 1"
  automatically; **+ Add another option** cuts a further one from a sheet, keeping every frame you
  select, in order, as that option's whole sequence. Every slice walks you through a finetune flow
  first — match this character's size, then flip/rotate/place the anchor (and optionally layer
  another image on top) one frame at a time — before anything's added; see "Slicing poses out of a
  sprite sheet" below. Multiple options are picked between at
  random, equally likely, every time the action starts — click **Make equally likely** to fill in
  the `Math.random()` conditions that guarantee that (a naive one-condition-per-option would bias
  toward the earlier ones; this doesn't). **Reset to standard animation** drops the whole override,
  back to exactly what the pack's own `actions.xml` defines.
- **Advanced edit…** (shown once an action actually has a custom override) opens full control:
  type (Stay/Move/Animate/Sequence/Select/Embedded), a border (Floor/Wall/Ceiling, if it should
  stay glued to a real ledge), raw params, and — for Sequence/Select — an ordered/conditional list
  of steps referencing other actions by name. A custom action with the same name as a standard one
  replaces it, exactly like editing that name's definition in `actions.xml` directly. Each pose's
  Image field also has its own **Fit precisely…** button here, opening the same pan/zoom fitting
  canvas the pose checklist uses, for when a plain path and thumbnail aren't enough to line an
  arbitrary custom pose up right.

Anything with no pose art of its own — a Sequence/Select dispatcher, a params-only Embedded
override — has no "frames" to simplify around, so it's listed separately underneath with just
Edit/Duplicate/Delete. **+ New action** still starts one from scratch.

**Behaviors** are the reactions — a name, a weighted frequency, an optional condition, and a list
of possible next behaviors once it finishes.

**Images** is the pack's own image folder: **Upload images…** copies files in from anywhere on
your computer (several at once), and each one can be deleted, or cleaned up with **Remove
background…** — colour-key transparency for a sheet that came with a flat coloured background
instead of a transparent one. Pick as many background colours as it takes (click the live preview
to sample one straight off the image), set a tolerance, and everything close to any of them goes
see-through. The result overwrites the image in place, so poses already pointing at it keep
working.

Conditions and param overrides use the same `#{...}`/`${...}` expression syntax as the real files
(e.g. `#{mascot.environment.floor.isOn(mascot.anchor)}`), validated as you type. Saving takes
effect immediately — every mascot currently wearing that character rebinds to the updated pack
without needing to respawn.

### Doing it by hand

The default pack folder (`Shimeji/`, alongside this README) already has the real, standard
`conf/actions.xml` + `conf/behaviors.xml` checked in. Drop your 46 images into
`Shimeji/img/`, named `shime1.png` … `shime46.png` (see `Shimeji/img/DROP_YOUR_PNGS_HERE.txt`),
then in **Settings → Shimeji Desktop Mascot**: click **Rescan**. Everything found is turned
on automatically the first time (see the **Characters** section to change that).

For a different or multi-character pack, point **Pack folder** at any vault-relative folder
laid out the same way:

```
<PackFolder>/
  img/
    shime1.png, shime2.png, ...
  conf/
    actions.xml
    behaviors.xml
```

Multi-character packs work too, using the same convention shimeji-ee uses: a folder per
character under `img/<Name>/`, with either `img/<Name>/conf/` or `conf/<Name>/` providing
that character's `actions.xml`/`behaviors.xml` (falling back to the top-level `conf/` if not
present).

Every pack must define `ChaseMouse`, `Fall`, `Dragged`, and `Thrown` actions/behaviors
(shimeji-ee itself requires this). Missing ones log a console warning but won't crash the
mascot — `Fall`/`Dragged`/`Thrown` in particular have native physics fallbacks regardless of
what's declared.

### Sound

If your pack ships sounds, a `<Pose>` can carry `Sound="file.wav"` and an optional
`Volume="-6"` — the same attributes real shimeji-ee reads, with `Volume` in **decibels of
adjustment** (0 = unchanged, negative = quieter), not a 0-1 fraction. Sound files are looked
for in the same three places the real engine checks, in order:

```
<PackFolder>/img/<Name>/sound/<file>     # this character's own sounds
<PackFolder>/sound/<Name>/<file>         # shared, per-character
<PackFolder>/sound/<file>                # shared, global
```

The `Mute` action is supported too: with a `Sound` parameter it silences that one file, without
one it silences everything.

Playback is **off by default** — turn it on under **Settings → Shimeji Desktop Mascot → Sound**,
where there's also a volume slider that scales every sound on top of whatever the pack itself
authored. (Real shimeji-ee defaults sound on; a note-taking app making noise unprompted felt
like a different proposition, so this is one of the few deliberate divergences.) A pose that
names a sound file that isn't there logs a warning at load and simply plays nothing.

### Slicing poses out of a sprite sheet

Poses are one image each, the way a real pack is built — but sprites are usually distributed as
a single sheet with every frame on it. The editor cuts one up for you: inside any action's pose
list, **Slice from a sheet…** opens the sheet with a grid over it:

- Set **Columns/Rows**, plus **Gap X/Y** if the sheet has padding around each frame (excluded
  from every cell and shaded red so you can see it is accounted for).
- **Drag any grid line** to move it, resizing the two cells it separates, for sheets whose frames
  aren't quite uniform. It snaps to whole source pixels and to match another cell's width, so
  landing on a consistent size is easy. **Double-click a line** to delete it and merge those
  cells back into one.
- **Click a cell** to select it. The numbers are the order the poses come out in; click again to
  drop it. **Shift-click** to use the same frame again later in the sequence, for a symmetric
  cycle like 1, 2, 3, 2 — a frame used twice is still only saved once.
- For a messy sheet with no usable grid, **Auto-detect frames** finds each sprite's own bounding
  box instead: it treats the chosen colours (and anything already transparent) as empty space and
  flood-fills what's left. **Min area** ignores dithering specks, and **Merge gap** reunites a
  sprite whose limbs got separated by background-coloured gaps inside its own silhouette.
- **Even strip** is the shortcut for a single row of equal-width frames.

**Add poses** writes each selected frame into the pack folder as its own PNG, named after the
action (`Walk-1.png`, `Walk-2.png`, …), and appends them to the animation. The sheet itself stays
put, so you can always come back and slice it differently.

Each pose's **anchor** — the point that actually stands on the floor — is set automatically to
the feet of the art inside its frame: the horizontal centre of the opaque pixels, at the bottom
of them. That is measured rather than assumed to be the middle of the cell, because a sprite is
rarely centred in its own frame, and a guessed anchor leaves the mascot hovering or drifting
sideways as poses change. Fix it up in the finetune step below, or by hand afterwards in
**Advanced edit…**.

When you're slicing frames for an action's animation (via **Set frames…** or the advanced
editor's own **Slice from a sheet…**, rather than fitting one image into a single standard pose
slot), the sliced frames go through a **finetune** flow before they're added anywhere:

- First, once, for the whole batch: **match this character's size**. A sheet's own cells are
  almost always a very different pixel size than the rest of a pack's 128×128 art, and unlike the
  standard pose slots (fixed to that size, cropped/padded to fit) a custom animation frame keeps
  whatever size it's given — so left alone, the mascot would visibly shrink or grow the moment this
  action played. A suggested scale factor (proportional, no distortion) is filled in for you, sized
  so the tallest frame in the batch lands around 128px tall; **Continue** applies it to every frame
  in the batch, or pick **Keep native size (1x)** if a different size is deliberate here (a "grown"
  transformation action, say).
- Then, one frame at a time: **Flip ↔ / Flip ↕ / Rotate ↺ / Rotate ↻** and a draggable anchor
  crosshair — the same orientation tools the pose checklist's own fitting canvas uses. **Next**
  moves to the next frame (**Finish** on the last one); **Skip remaining** accepts whatever's left
  as-is; closing the step early (or **Cancel**, at either stage) only skips adding this batch — the
  sliced files stay in the pack folder regardless, same as any other slice.
- **Layers**, on any frame: place another image on top of it — a particle effect over a couple of
  frames of a jump, say. Pick an existing pack image, upload one, or slice one from a sheet; drag it
  into position, flip/rotate it if it needs orienting, then **Place layer** to flatten it into the
  frame. Sequential rather than simultaneous — once placed, a layer is just part of the frame and
  can't be nudged independently afterward — which keeps this a small addition rather than a full
  multi-layer editor with its own undo/reorder/visibility machinery.

**Velocity** is left at zero on a fresh slice on its own (`posesFromPlan`'s neutral default — how
far a step carries the mascot belongs to the action, not to the picture, so a guessed speed would
be its own kind of wrong). But when the finetune flow above is *replacing* an action's own frames,
it already knows that action's real speed — its current custom animation if it has one, otherwise
the pack's original definition — and carries that forward onto the new frames automatically (every
Pose in a real Move action holds one constant velocity across its cycle, so this is exact, not a
guess). An action that never moves (Sit, Stay, …) is untouched either way. Adjust it by hand
afterwards in **Advanced edit…** if the new frames should move differently than the old ones did.

### Seeing it move

Every action has a **▶** button in the list, and the editor has **Save & play**. Both run that one
action on a live mascot immediately, with no behavior owning it — so you can watch a set of poses
you just sliced without first inventing a behavior, giving it a frequency, and waiting for the
weighted pick to land on it. Save & play commits first and stays in the editor, because a mascot
plays what is in the built pack; previewing an uncommitted draft would animate the old version
while the screen showed the new one.

It plays on a mascot already wearing that character, preferring one that is standing on something.
If none is, it says so rather than spawning one — a fresh spawn falls in from above, and a
Floor-bordered action started in mid-air immediately loses its ground and turns into a fall, which
looks exactly like a broken animation.

## Speech

Mascots can say things, from a plain markdown note in your vault that you edit like any other.
**Settings → Shimeji Desktop Mascot → Speech** has the toggle, the path, and a status readout.

The file is created for you on first run, at wherever your vault puts new notes. Each plain line is
one thing a mascot can say, tagged with `@` and a **behavior name**:

```markdown
Put me down! @Dragged
Wheeeee! @Thrown
Off I go. @Walk
Think I'll sit here a while. @SitDown
```

`@` rather than `#`, because `#` is already an Obsidian tag and this is a real note.

**A tag also matches any behavior starting with it, and the most specific one wins.** That is what
makes the file writable: the bundled pack has 57 behaviors, eight of them some flavour of walking,
and nobody is going to write lines for `WalkLeftAlongFloorAndSit` by hand. `@Walk` covers all of
them; add `@WalkAlongIECeiling` later and it takes over for that one. A line can carry several tags.

The legal tags are whatever your character's `behaviors.xml` defines, so the generated file lists
every one of them in a callout at the top — a cheat sheet that is correct for the pack you actually
have, rather than for the one this README was written against. That callout is only ever written
once, though, so a character loaded afterwards, or a vault-reaction/custom-trigger tag added later,
won't be in it — the list-checks button next to the file path (Settings) rewrites just that one
line to match what's legal right now, without touching anything else you've written.

**Headings, callouts, code blocks and comments are never spoken**, so you can annotate the file
freely — including writing `@Walk` inside them as an example. Without that, a file explaining its
own tags would recite the explanation.

Saving the note reloads it immediately; there is no separate step.

**A line can embed a vault image**, and it shows up as an actual picture in the bubble, at
whatever size you gave the embed:

```markdown
Check this out! ![[chart.png|120]] @Sit
```

Lines are rendered as markdown, not plain text, so this is just Obsidian's own embed syntax —
`![[name]]`, `![[name|width]]`, `![[name|widthxheight]]` — doing what it always does. No special
casing needed; the same is true of a redirected line shown in an open chat (see Vault reactions
below and AI Assistant above).

### How often it talks

Speech is triggered by a mascot **starting** a behavior it has a line for. Everything a mascot does
is a behavior and they change every few seconds, so left unchecked it would be a running
commentary. Three things hold it back:

- **How chatty** (Settings, 25% by default) — the chance an eligible change actually says something.
- A quiet period per mascot, and a shorter one across all of them so a crowd doesn't talk at once.
- A line suppressed by either of those is not owed later. The remark was about starting to do
  something; by the time the mascot could say it, it is already doing it.

If a mascot says nothing, that is indistinguishable from it being broken — so the settings screen
reports how many lines and tags parsed, flags any tag no behavior could match (a typo), and flags
lines that forgot their tag.

### Vault reactions

*Not a port of anything* — shimeji-ee has no concept of files or vaults at all. A mascot standing on
the pane you're actively working in can also remark on the vault itself, not just on what it's
doing: a note opened, created, deleted, renamed, or edited. **Settings → Voice → Vault events** has
the toggle — off by default, so `@note:open` doesn't start talking the moment this ships.

It's the same speech file as above, not a second system: tag a line with one of these five instead
of (or alongside) a behavior name.

```markdown
Welcome back! @note:open
New page, let's go! @note:create
Aw, it's gone... @note:delete
Nice edit! @note:edit
Ooh, a new name! @note:rename
```

Same rules as everywhere else in the file — longest-prefix matching (a bare `@note` catches all
five if you'd rather write one line than five), several tags on one line, headings/callouts/code/
comments never spoken. A mascot currently living in the plant room stays quiet; it isn't standing on
any pane at all.

Edits are debounced rather than cooldown-only, since Obsidian autosaves as you type: a remark for
`@note:edit` only fires once you actually pause, never mid-keystroke.

### Custom triggers

The five above are the built-in set; **Settings → Voice → Vault events → Custom triggers** adds
more. Obsidian fires far more events than those five — file-open, editor-change, layout-change, a
theme switching, and whatever any installed community plugin fires on top of it — and any of them
can be bound to a tag of your own choosing: pick the source (workspace, vault, or metadata cache),
type the event's name, type a tag. No `note:` prefix required; it's just a tag like any other.

Start typing in the event name box and every event Obsidian's own API documents for the source
you picked shows up as a suggestion — that list is exhaustive for Obsidian itself, pulled straight
from its published API, not guessed. A community plugin's own events are its own to document, not
Obsidian's, so those still mean checking that plugin's own docs/source, or the developer console
(Ctrl/Cmd+Shift+I) while you make it fire and watch what shows up. Bindings apply immediately, no
reload needed, and every custom tag is checked against the speech file the same way the built-in
ones are, so a typo is flagged instead of just staying silent.

Deliberately generic: no debouncing, no argument-reading, no special-casing beyond what every vault
reaction already gets. If the bound event fires on every keystroke, expect the same reaction —
`@note:edit`'s 1.5s debounce is hand-tuned for that one specific case, not something a custom
binding gets for free.

### Character-specific speech

**Settings → Voice → Character-specific speech** lists every loaded character with a field for its
own dedicated lines file. Leave it empty and that character keeps using the general file above,
same as before this existed; give it a path (the pencil button creates one, seeded with the same
real examples the general file gets) and only that character reads from it — everyone else is
unaffected.

An override with nothing tagged in it yet doesn't go silent: a character falls back to the general
file until its own has something written in it, so setting one up is never a way to accidentally
mute a mascot mid-edit. The status line under each character says which is currently in effect and
how many lines and tags its own file has.

## AI Assistant

**Settings → AI Assistant**, off by default.

- **Enable AI assistant** — the master switch. Nothing calls out to any backend while this is off.
- **Backends** — not one active provider but an ordered list of any number of them. Sending a chat
  message tries each backend top to bottom, skipping straight past any that are unconfigured or
  already at today's own limit, and falls through automatically to the next one if a backend errors
  or comes back rate-limited — the whole point being to put a free-tier backend ahead of a paid one
  so the paid one only ever gets used as a genuine fallback, or to queue up several free backends
  behind each other so one running out mid-conversation doesn't end it.

Each backend in the list has:
- **Order** — up/down arrows moving it earlier (preferred) or later (more of a fallback) in the
  try order, and a trash icon to remove it.
- **Name** — just a label for telling backends apart in this list and in status/error messages;
  never sent anywhere.
- **Kind** — **Anthropic**, or **OpenAI-compatible** (anything that speaks the OpenAI
  chat-completions wire format — every free-tier preset below, and most local servers, are this).
- **Server URL** (OpenAI-compatible only) — base URL; `/chat/completions` is appended
  automatically.
- **API key** — from the provider's own console for a cloud backend; almost always blank for a
  local server, since most (Ollama included) don't check one at all.
- **Model** — a plain text field rather than a fixed dropdown, since every provider here ships new
  models on its own schedule.
- **Daily limit** — requests per day before this plugin stops trying this backend until tomorrow;
  0 means unlimited. A backend that comes back rate-limited gets benched for the rest of the day
  regardless of this number — that's the provider itself saying the real limit is already hit,
  which this plugin otherwise has no way to know.
- **Status / Test** — how many requests this backend has answered today (or that it's currently
  rate-limited), plus a **Test** button that sends one trivial message straight to that backend,
  bypassing the try-in-order chain and its limits entirely, so a key can be verified before relying
  on it.

**Add a backend** offers presets for a few providers with a real free tier, verified against each
one's own current docs, alongside **Custom / other** for anything else (a local server included):

- **Groq** — `https://api.groq.com/openai/v1`. Doesn't train on API requests by default and states
  it doesn't log prompt/completion content beyond brief transient error monitoring.
- **OpenRouter** — `https://openrouter.ai/api/v1`. Zero data retention by default; pick a model id
  ending in `:free` to stay on the free tier.
- **Cloudflare Workers AI** — account-scoped
  (`https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1`), so the preset's own URL
  needs your account id filled in before it can work at all.
- **Google AI Studio** (Gemini, OpenAI-compatible) — the free tier's own terms allow human review
  and training use; adding billing to the Google Cloud project behind the key (while still staying
  under the free daily quota, so nothing gets charged) switches it to Google's no-training
  commercial terms instead.

Each preset's own privacy note pops up as a toast the moment it's added, since that's the most
relevant moment to actually read it — but a provider's own current policy is always the source of
truth, not this plugin's description of it, especially for anything free.

A local server (Ollama, LM Studio, llama.cpp's own server mode, a llamafile — anything speaking the
OpenAI-compatible format) is just a **Custom** backend with its base URL pointed at
`http://localhost:11434/v1` or wherever it's actually listening. Reaching one from **Obsidian
Mobile** means the server has to be reachable over the network — the same Wi-Fi at home, or a
tunnel like Tailscale when away from it — since a phone can't run the server itself (no Obsidian
plugin can run local inference on iOS/Android; there is no native bridge for it). That's a
networking setup on your own end, not something a backend choice changes.

Every backend's requests go out through Obsidian's own `requestUrl` rather than the browser's
`fetch` — `fetch` from a plugin's renderer process hits the same-origin/CORS restriction a direct
call to an API would trip; `requestUrl` goes out through Electron's main process instead, which
isn't subject to it. This is why every Obsidian AI plugin uses it instead of `fetch`.

### Chatting with a resident

The plant room has a small **Chat** button in its top-right corner. Click it and the room picture
gets a transcript docked directly above it — same bubble look (theme or comic, whatever
**Settings → Speech bubble style** has set, tail and all) as an ordinary remark, sized to match the
room picture's own width and height rather than filling whatever space happens to be free above
it — and a thin input bar, always in Obsidian's own native look regardless of that style, docked
directly below the picture. The room itself never changes size or position to make room for
either one; they only ever use whatever space the pane already has above and below it, shrinking
rather than growing past it, which is why the layout suits a tall sidebar particularly well. Type
in the bar and press **Enter** (or click **Send**) to talk; the toggle button closes it again.

**Paste an image straight into the input** (a screenshot, a copied picture) and it attaches as a
small thumbnail chip, sent alongside whatever you typed. Paste more before sending and each one
gets its own chip — every pasted image goes out together with that one message, not just the last;
click a chip's own × to drop just that image beforehand. It's genuinely sent, not just shown —
Anthropic and any OpenAI-compatible vision-capable model can actually see it, using each provider's
own real image format. A backend that can't (most local/free-tier text-only models) just fails on
that one request; with more than one backend configured, the existing automatic-failover chain
already tries the next one, so nothing extra needs configuring to fall back to a text-only model.
No compression or resizing is attempted — every pasted image goes out as-is, capped only per-image
at a size sane enough to not hang the browser on an enormous screenshot.

Messages render as plain markdown text rather than boxed bubbles — your own turns align right in a
muted colour, the assistant's align left in the ordinary text colour. It is still the mascot's own
speech bubble, not a separate window: it's drawn against whichever resident is currently home,
follows the room if the pane moves or resizes, and disappears if the resident leaves. Closing it
keeps the conversation — reopening the same resident's chat picks back up where it left off — but a
different resident, or the same one moving out, clears it. Nothing is saved to disk; a restart
starts fresh. With no API key set, sending a message reports that in the transcript instead of
failing silently.

The assistant is always told to reply with only the words actually spoken — no asterisk actions,
no stage directions — regardless of persona; this is a format rule, not character voice, so a
custom persona file doesn't need to ask for it itself.

While chat is open, the resident's own ambient and vault-reaction lines (Character-specific speech
and Custom triggers, below) stop popping up as a separate floating bubble over its head — they
appear as a red entry inside the transcript instead, so a mid-conversation aside doesn't compete
with the chat bubble for the same spot on screen. They're shown, not sent: the assistant never sees
them as something it or you said.

Confirmed note edits (having the assistant propose changes it can write with your approval) are
covered in their own section below.

### Active note

**Settings → AI Assistant → Active note**, off by default, works on mobile too. With it on, every
chat message includes the title and content of whichever note is currently open in the workspace,
so "what note is open" or "check the grammar in this note" actually has something to answer from.
Off means genuinely nothing about the active note is added — not even its title — which is why
asking either of those questions with it off gets an honest "I have no way to know," not a wrong
guess.

A long note is truncated rather than sent in full, the same "generous but capped" treatment vault
search below gives each note it retrieves — enough of a real note to be worth reading, not enough
to let one huge note dominate a whole message's own context on its own. Independent of vault
search: this is always exactly the one note on screen, not a ranked search over the rest of the
vault, and needs no local model to work.

### Vault search

**Settings → AI Assistant → Vault search**, off by default, desktop only. Lets a chat message pull
in relevant notes automatically, using a small embedding model
([`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) that runs entirely
on-device via [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) — no
separate server, no extra API key, nothing about the search step itself leaves the machine. It
downloads once over the network the first time it's actually used (tens of MB) and is cached
afterward.

Turning it on indexes every markdown note **except whatever's listed under "Never search these
paths"** — one folder or file per line, matched the same real folder-prefix way [Smart
Connections](https://github.com/brianpetro/obsidian-smart-connections)' own exclude-folders
setting works: excluding a folder excludes everything inside it. Empty by default, so nothing is
held back until a path is actually opted out — useful for a journal, financial notes, anything the
AI should never see even indirectly through a retrieved excerpt. Each remaining note is split at
its own headings — every `#` through `######` starts a new chunk, and whatever comes before the
first heading (or the note's whole text, if it has no headings at all) is its own chunk too — and
each of those chunks is embedded and cached separately, rather than the note as one single
embedding. That's what lets one specific section of an otherwise-unrelated long note actually
surface in a search, instead of a whole-note embedding averaging that section away into "this note
is generally about a lot of things." Whichever chunks come from one note share that note's own
modification time, so a note that hasn't changed since it was last indexed is never re-embedded,
and a path added to the exclusion list afterward is dropped from the cache on the next rebuild even
though the note itself still exists. Editing, creating, deleting, or renaming a note updates the
index incrementally in the background (the same "wait for edits to settle" debounce the rest of the
plugin already uses for vault reactions) — **Rebuild index** in settings forces a full pass, useful
right after turning the feature on for the first time (or after changing the exclusion list), and
its status line shows how many notes are indexed so far.

Sending a chat message embeds it the same way and finds the **Notes per message** most relevant
already-indexed chunks — not notes; two different sections of the same note can both show up if
both are genuinely relevant, each labelled with its own heading — splicing their content into that
message's context before it goes to whichever backend actually answers it. This is the one
important caveat: the search itself is local, but the notes it finds are only as private as that
backend — a note retrieved this way goes out over the network exactly like anything typed into the
chat by hand, for any backend that isn't itself fully local.

Desktop only: the model is a real (if small) machine-learning workload, heavier than this plugin
otherwise asks of a phone, in keeping with the wizard's own desktop-only treatment below.

The embedding *model*'s weights are what downloads on first use, as above — the separate ONNX
WASM runtime that actually executes it ships with the plugin itself (an `onnx-wasm/` folder next
to `main.js`), which is the reason this plugin's own install size is noticeably bigger than its
feature set alone would suggest, even for someone who never turns this setting on.

### Confirmed note edits

**Settings → AI Assistant → Note edits**, off by default, works on mobile too — unlike vault
search above, this needs no local model, just whichever backend is already answering.

When it's on, the assistant is told it may propose a concrete change to the note you're
discussing — a grammar fix, a callout, an embed, whatever the conversation calls for — instead of
only describing one in prose. A proposal shows up as its own small card under that reply, with a
rendered preview of exactly what it would add and two buttons: **Apply** and **Discard**. Nothing
is ever written to a note on its own; Apply is the only thing that touches the vault, and it only
does one thing — append the proposed markdown to the note that's currently active in the
workspace. If nothing is open when you click it, the card reports that instead of writing
anywhere, so you can open the right note and try again. Discard just dismisses the card; either
button is final for that particular proposal, and a fresh reply is a fresh card.

This is deliberately not real tool-calling — it's a plain fenced code block the model writes as
part of an ordinary text reply, the same way it would write any other code block. That works
identically across every provider this plugin talks to, including a small local model, without
needing function-calling support from any of them.

### Related notes while writing

**Settings → AI Assistant → Vault search → Suggest related notes while writing**, off by default,
only available when vault search itself is on (it reuses the exact same local index rather than
building a second one — see Vault search above).

With it on, a mascot on the pane you're working in mentions notes that look related once edits to
the active note settle — the exact same "wait for a pause, then remark" mechanism vault reactions
already use for things like `@note:edit`, just triggered by a live search instead of a fixed tagged
line. The remark is real wikilinks (`[[Like This]]`), so clicking one navigates like any other note
link. It only ever speaks — nothing is written to the note, and a suggestion that hasn't actually
changed since the last time it was mentioned for that note isn't repeated just because the debounce
fired again.

### Right-click rewrite

**Works whenever Note edits above is on** — no separate toggle, since it's the same underlying
permission (an AI-proposed change to a note that needs your own Apply click before anything
happens), just reached from a different place.

Select some text in a note, right-click it, and a few commands appear — **Ask the mascot: Fix
grammar & wording**, **Make more concise**, **Improve clarity**. Each opens a small window showing
the original passage, then the rewritten version once it comes back, with **Apply** (replaces
exactly that selection, in place) and **Discard** buttons. This is a separate, smaller flow from
the chat's own note-edit cards on purpose: rewriting *this specific passage* only makes sense while
that exact selection is still the one being talked about, which a window that closes before you
walk away guarantees in a way an open-ended chat conversation can't. The rewrite itself is
deliberately *not* asked for in the resident's own character voice — a wording fix in your notes
shouldn't come back sounding like whichever character happens to live in the room, however fun that
voice is in chat.

### Character personality

**Settings → AI Assistant → Character personality** lists every loaded character with a field for
its own **persona file** — a plain note in your vault, the same idea as Character-specific speech's
files above. Click the pencil to create and open one (seeded with that character's current default,
so you're editing something rather than staring at a blank page); whatever is written there,
verbatim, becomes its system prompt. Saving the note in Obsidian reloads it immediately, same as a
speech file — no round trip through the settings screen needed.

No file set, or the file is empty, and that character gets a generic-but-in-character default
("You are *name*, a small desktop companion living in the user's Obsidian vault...") instead of a
blank or generic-sounding assistant — the same "an override is additive, never a way to go silent"
shape Character-specific speech uses for the ambient speech-bubble pool above. Each row's own
**Test** button sends a one-line, in-character reply request through that pack's resolved persona —
a quick way to hear the voice without opening chat.

## "Get to that spot" — Shift + triple-click

**Shift + triple-click anywhere** in the window and the nearest mascot goes there. Not near there —
*there*.

If the point isn't on any surface, there are two ways to be there anyway — **fall through it**, or
**build a surface at it** — and the mascot costs both in ticks and picks the quicker:

- *Fall through*: hang from a ceiling directly above (or walk off the edge of a pane above), let go,
  and for a moment it is exactly there. Costs nothing but the trip to the departure point.
- *Build*: walk to a pane's **+ button**, press it, then shove the resulting divider into place.

**The building is physical, not magic.** The mascot doesn't summon a pane where it needs one: it
routes to a real new-tab button, presses it, and gets whatever split Obsidian gives it — which lands
at the host pane's midpoint, not at your click. Moving it from there costs the mascot standing on the
divider and leaning on it, at 7px a tick, with the same animations it uses for ordinary pane
wrangling. Everything you see it do, it did.

That also makes the plan a chain rather than a wish, and the cost estimate follows it honestly: the
walk to the button, then the route from the button to wherever the split actually landed, then the
shove. Which plan wins depends entirely on the layout. Stacked panes catch every fall, so there is no
drop to be had at any price and the split wins; standing on a pane whose edge is right above the spot
makes the drop nearly free and the button is a long climb away.

Either way, any point in the window is reachable: if the terrain doesn't reach, the mascot either
falls through it or changes the terrain.

- Bounded to two layout changes per order, so a spot that genuinely can't be reached (inside chrome,
  or a pane too small to split) can't turn into an endless run of new panes.
- The pane it opens is **left standing** — closing it the moment the mascot arrived would pull the
  floor out from under it. Tidy up with the **"Close panes opened by mascots"** command.
- Clicking the mascot cancels the order, same as it cancels following.
- Turn the layout-changing part off under **Behavior → Open panes to reach a spot**; the order still
  works, but limited to surfaces that already exist.

Shift is what makes the gesture safe to listen for: a bare triple-click is ordinary text selection.
The listener is passive — it never calls `preventDefault`, so the clicks still do whatever Obsidian
would normally do with them.

## Card-style themes

Themes that render each pane as an inset card (Minimal's card layout, and similar) leave a few pixels
of space between neighbouring panes instead of letting them share an edge. Pane edges that sit at the same
height with only a narrow gap between them are joined into one continuous surface, so a mascot walks
across the join instead of falling down it. Gaps wider than 16px are left alone — at that point it is
a real hole, and falling through it is the right answer.

## Testing movement inside Obsidian

Two commands, because they catch different things. Both write a Markdown report into the vault and
open it, so it can be read and pasted straight back.

**"Run movement self-test"** — the one to reach for. Start it and leave it alone; it needs no input.
It spawns a second mascot and records two things at once: the first runs the script (every movement
behavior the pack declares, one at a time, then a lap of the real window — both walls, the ceiling,
the floor, every open pane's top edge), while the second is left to its own devices on the pack's own
behavior chain. Both land in one report, with a `who` column telling them apart.

The second mascot is worth recording precisely because nothing is driving it: ordinary idle wandering
is what a mascot spends most of its life doing, and no other test here watches it.

Two mascots rather than one, deliberately: touching a mascot cancels whatever order it is carrying
out, so scripting and interacting with the *same* one leaves the scripted legs measuring nothing. If
you do want to drag something mid-run, drag the unscripted one — and if you pick up the scripted one
by mistake, the report says the leg was skipped rather than reporting a routing failure.

Takes a few minutes at real speed; a status-bar item shows the current step, and running the command
again cancels and still writes the partial report.

Reports land in a `Shimeji reports/` folder and are **not** opened automatically — a long run makes a
big note, and Obsidian re-renders open notes on every reload, so auto-opening one was enough to stall
the app until it was deleted. Timelines are capped at 400 evenly-sampled rows; anomalies are never
sampled away.

**"Start/stop recording movement"** — the plain recorder, with no script at all, watching every mascot
on screen. Use it when you want a long unstructured session, or to chase something specific you can
already reproduce.

Both flag the same anomalies automatically — a frame-to-frame jump over 60px (a teleport), a position
going NaN, leaving the window, or standing still through a leg that was supposed to be travelling —
and the report lists them at the top before the timeline.

This is deliberately separate from the headless test suite. That suite simulates against synthetic
geometry, so it only ever checks what the geometry model says should happen; everything downstream is
invisible to it — the ledge scan over real DOM rects, panes moving underfoot, frame pacing against
the fixed timestep, rendered position versus physics position.

For a quick look without a full run, the console has `shimejiDebug.where()` (a snapshot of every
mascot and what it is standing on) and `shimejiDebug.watch(5)` (a five-second frame-by-frame track).

## Getting around: route-finding

Mascots plan routes across the surfaces that actually exist, rather than only pacing whichever floor
they happen to be on. A route is built from five kinds of step — **walk**, **climb**, **traverse**
(along a ceiling), **jump** and **drop** — each of which maps onto an action your pack already has
(`Dash`, `ClimbWall`, `ClimbCeiling`, `Jumping`). That mapping is why the set is exactly those five:
a route the pack cannot animate would be unplayable.

**Routes are costed in time, not distance**, which matters more than it sounds. The standard pack's
own animations differ by over an order of magnitude — `Dash` covers 8px a tick, `Jumping` 20, while
`ClimbWall` averages 0.64 (36px of travel spread over 56 ticks, most of them hold frames). So a
mascot will drop off an edge rather than climb the same height back down, and take a longer jumped
route over a shorter climbed one — because it genuinely is quicker. Costing by distance instead
priced a 300px climb as cheaper than a 400px walk, when it actually takes nine times as long.

How much a long journey counts against a surface that gets *closer* is the caller's choice, not a
property of the geometry. Chasing the pointer isn't worth a 400-tick wall climb to close the last few
hundred pixels, so following weights travel time heavily; a "get to that spot" order weights it near
zero, because its whole promise is reaching the point.

The graph is built from the same ledge list the physics uses, so a route can never describe a surface
the mascot can't actually stand on. Surfaces connect where they physically meet (a floor meeting a
wall is how a mascot gets off the ground at all), plus jumps up to a nearby higher floor and drops off
the end of a raised one.

**Standing beats hanging when both are on offer.** Obsidian stacks surfaces on top of each other
everywhere — a pane's underside and the next pane's top edge are the same line — so "closest surface
to where I'm going" is constantly a near-tie between a floor and a ceiling. Left to chance, a mascot
ends up upside down under a ledge it could have walked along, which reads as a glitch rather than a
choice. A floor is worth 80px of extra distance, which settles those ties decisively while still
losing to a ceiling that is genuinely much closer to the target.

Two things use it:

- **Following the mouse now works vertically.** Point somewhere high and the mascot climbs a wall,
  crosses a ceiling or hops between panes to get there, instead of standing on the floor beneath you.
- **Wandering** — mascots occasionally pick somewhere else entirely and route to it, which is what
  produces climbing and pane-hopping during ordinary idling. Toggle under **Behavior → Wander the
  whole window**; off keeps them on whichever surface they're on, closer to how the original behaves
  on a bare desktop.

Nothing in shimeji-ee corresponds to this. Its mascots live on one desktop with a few tracked
windows, and every movement behavior is authored per-surface ("walk to a random x on *this* floor") —
the original never asks "how do I get *there* from *here*", so there was no algorithm to port.

A target that isn't on any surface — a pointer hovering over the middle of the editor — is handled by
getting as close as the geometry allows. That conclusion only stands for as long as the pointer it
was computed against does: move the pointer more than ~64px and the mascot abandons its current leg
and re-plans immediately, rather than finishing a walk toward where you used to be. So you can lead
one around the window for as long as you like, and it keeps coming. It stops when you tell it to —
click the mascot, or use the stop command — not because it decided it was close enough.

## Following the mouse

Real shimeji-ee's "Follow Cursor" tray item is a **one-shot**: `Manager.setBehaviorAll(config,
"ChaseMouse", imageSet)` is a single `setBehavior` call per mascot, and from there the pack's own
`NextBehavior` chain takes over. In the standard pack that chain is a deliberate cul-de-sac —
ChaseMouse leads (`Add="false"`) to SitAndFaceMouse, and SitAndFaceMouse leads (`Add="false"`) to
*itself* at `Frequency="100"`. So the real, correct outcome is:

1. get off any ceiling, wall or pane it happens to be clinging to;
2. dash toward the pointer's **x** three times, in randomised increments, stopping up to 200px short
   on purpose;
3. sit and watch the pointer, turning to face it, indefinitely.

It never matches the pointer's *y* — it stays on whatever surface it's standing on — and it never
starts chasing again by itself. If your pointer already happened to be near the mascot, all three
dashes have almost no ground to cover and it looks like it barely moved before sitting down.

**"Make all mascots dash to the mouse (once)"** is exactly that behaviour, unchanged.

**"Keep all mascots following the mouse"** is an invented addition, and a real pursuit rather than a
repeat of the above:

- It runs **until it reaches you** — within 32px horizontally. It is not on a timer, never gives up
  partway, and no number of steps exhausts it.
- Each step is an ordinary pack `Move` (`Dash` — real physics, real animation) aimed at the
  pointer's live x, capped at 160px so the aim stays fresh. That's a deliberate choice over
  re-running ChaseMouse, which *structurally cannot* close the last stretch: its final `Dash` targets
  `cursor.x + Gap` where `Gap` is `-Math.min(distance, Math.random()*200)`, so once you're inside
  200px that target collapses onto the mascot's own position and it stops dead.
- Arriving ends the pursuit, not the mode. It settles into the pack's own sit-and-watch chain but
  stays armed, so moving the pointer away picks the chase straight back up.
- **Touching the mascot cancels it** — grabbing it, poking a hotspot, or just clicking it. So does
  **"Stop all mascots following the mouse"** and the matching per-mascot menu item.

It only ever matches the pointer's x, like the real ChaseMouse: the mascot stays on whatever surface
it's standing on, so "reached you" means directly below the pointer.

If your pointer leaves the Obsidian window entirely, no more `pointermove` events arrive and the
tracked position simply holds its last in-window value — the mascot walks to that spot and settles
there rather than hanging. Relatedly: the pointer tracker listens in the **capture** phase, because
in the bubble phase any Obsidian or CodeMirror handler calling `stopPropagation()` on a pointer event
would starve it, which would show up as chasing that silently freezes over one particular pane and
works fine over others.

## Grab it by the feet (invented, on by default)

Pick a mascot up by its **lower third** and it hangs upside down from your cursor, held by the
ankles. Grab it anywhere higher and you get the ordinary drag, pinched by the head.

The grab point being meaningful is real: `Dragged.java` has `OffsetX`/`OffsetY` parameters and puts
the mascot's anchor at `cursor + offset` every tick, and its default `OffsetY` of 120 is exactly
what makes the normal drag a pinch by the head — with the standard `ImageAnchor="64,128"` on a
128px sprite, the cursor lands 8px below the top of the frame. Holding it by the feet is just
offset 0, so the soles sit at the cursor.

The **vertical flip is invented** — the real engine has no such thing anywhere; `setLookRight`
mirrors horizontally and that is the only orientation it knows. Toggle it off under
**Settings → Shimeji Desktop Mascot → Behavior**.

Two notes on how it fits with the real mechanisms:

- A pack-authored `<Hotspot>` always wins the click. The orientation choice only runs on the path a
  declined hotspot scan falls through to.
- It is deliberately *not* implemented as a `<Hotspot>`. A real Hotspot *replaces* the drag rather
  than starting one, and is declared per-`<Animation>` — so "grabbable by the feet whatever it
  happens to be doing" would mean copying the region onto every action in the pack and would still
  be unable to pick the mascot up. Where the mascot is held is a property of the grab, so it lives
  on the grab path.

## Pane wrangling (invented, on by default)

Obsidian's replacement for the original engine's window throwing, and the more useful half of it in
practice. Mascots interact with your actual layout:

- **Squash** a stacked pane by landing on its top edge and leaning on it — the pane shrinks and the
  mascot rides the edge down.
- **Haul** a pane's bottom edge downward while hanging underneath it, making it taller.
- **Shove** side-by-side panes apart by bracing against one's side.
- **Fold** a sidebar shut by sitting on it.

Turn it off under **Settings → Shimeji Desktop Mascot → Behavior → Pane wrangling** if you would
rather they left your layout alone. Resizing is clamped to 10–90% of a split, so a mascot can't
squash a pane out of existence.

### Why it borrows your pack's existing animations

The original animates window manipulation with a trick that isn't available here: it clips the
sprite against the window frame, so the mascot looks like it's gripping an edge from behind. A DOM
overlay can't clip against a pane it doesn't own. So these interactions reuse animations your pack
*already has* — a hard landing to squash, a ceiling hang to haul, a wall grip to shove — referenced
**by name**, never by image filename. That's what makes it work across a multi-character pack whose
sprite sheets differ.

Mechanically it's two attributes any action can carry, rather than four new actions:

| Attribute | Effect |
| --- | --- |
| `PaneResize="-7"` | Push the touched pane's edge by that many pixels *per tick* while this action runs |
| `PaneResizeByFacing="true"` | Multiply by facing, so it always pushes away from the mascot |
| `Sidebar="collapse"` | One-shot when the action starts (`collapse` / `expand` / `toggle`) |

Which pane, and which dimension, come from what the mascot is physically touching — never from the
attribute — so a squash can't accidentally resize a pane sideways. The whole set is layered in
through the same custom-content merge your own edits use, and is applied *first*, so **an action or
behavior you author with the same name replaces it outright**. The names are `PaneSquash`,
`PaneHaulDown`, `PaneShove` and `PaneFoldSidebar`.

Still to come: authoring genuinely new animations — importing your own frames and scripting them
from inside Obsidian — rather than only recombining a pack's existing ones. The custom-content
editor already builds actions and behaviors; what it lacks is an image-import path and a pose
timeline.

## Window mischief (experimental, off by default)

Real shimeji-ee mascots can grab the OS window they're standing next to, carry it along while
walking, and throw it — `WalkWithIE`/`RunWithIE`/`ThrowIE` in the real source, reachable
autonomously whenever a mascot ends up on the ground below and to the side of a recognized
window (real `Main.java`'s activeIE maps here to whichever pane the mascot is currently against —
see "Approximated, not literal" above). Obsidian panes aren't free-floating OS windows, so this
couldn't be a literal port, but it's not nothing either:

- **Carrying a window along while walking is reinterpreted as resizing the pane** instead of
  moving it — however far the mascot's own real walk physics moves it that tick is exactly how
  much the pane grows or shrinks, in whichever direction its own layout actually resizes (a
  side-by-side split resizes left/right, a stacked split resizes up/down — decided by the pane's
  real layout, not hardcoded). This leans on Obsidian internals that aren't part of the
  documented plugin API (confirmed working by reading the source of a real published plugin,
  [`obsidian-resize-split`](https://github.com/RyotaUshio/obsidian-resize-split), that does the
  same thing) — if a future Obsidian release changes them, resizing just quietly stops
  happening, nothing else breaks.
- **The throw itself is the real thing**: the pane pops into its own genuine OS window
  (`Workspace.moveLeafToPopout`, desktop only) and gets thrown with the *exact* real ballistic
  formula (`ThrowIE.java`'s own per-tick `InitialVX`/`InitialVY`/`Gravity`), driven by repeatedly
  moving that real window. A "Restore thrown windows" command/menu item (real `Main.java`'s
  "Restore IE!") brings every popped-out window back if one ends up somewhere inconvenient — the
  original has the exact same escape hatch for the exact same reason.
- **Off by default** (Settings → "Window mischief"), because unlike everything else this plugin
  does autonomously, this can resize your actual layout or spawn a separate OS window without
  asking first. Turn it on if you want the real chaos; the toggle is instant and reversible
  (resizing) or one click away from reversible (restore).
- **Genuinely untested, not just unverified-by-source** — see `SOURCE_AUDIT.md`'s "Open live-bug
  reports": both the undocumented resize API and whether Obsidian's Electron process actually
  lets a popped-out window be moved this way need a real desktop window to confirm, which this
  headless environment can't provide. Please report back if either one doesn't visibly do
  anything.

Alongside this, and *not* a port of anything — shimeji-ee has no concept of files or vaults at
all — **note mischief** (Settings → "Note mischief", also off by default) occasionally swaps in a
random other note from your vault while a mascot happens to be standing on the pane you're
actively working in. Purely for fun; nothing is lost (the file you were on is still there,
autosaved, one click of "back" away).

## Size on different screens

**Size** is a multiplier on the pack's own artwork, and **Scale with the window** (on by default,
under Characters → Size & number) reads it as a fraction of the window rather than a fixed pixel
count — driven by the window's *smaller* dimension, so a short wide editor does not decide it has
room to grow the mascot over the text. A size chosen on a laptop then still looks right on a phone
and on a large monitor, instead of being identical in literal pixels on all three.

It scales the setting and nothing else. Each pose still renders at its own natural pixel size, the
way the Java engine draws it — nothing measures the pack's sprites or normalises them against each
other, so adding one unusually large frame (an effect, a puff of smoke) cannot shrink everything
else. Turn it off to get a flat multiplier that renders the same everywhere.

## On mobile

A mascot walking across a phone screen sits exactly where your thumb is trying to type, so by
default it only takes taps and drags while the active note is in **reading view** — everywhere
else, touches pass straight through to whatever is underneath. It carries on walking, falling and
reacting either way; this gates input, not life. Turn it off under Interaction → Touch & mobile.
Desktop is never affected.

The world's floor and walls stop short of the literal bottom of the screen, mirroring
`getWorldTop()`'s title-bar exclusion (see below) for the opposite edge — Obsidian Mobile docks a
toolbar to the bottom of the screen, and without this a mascot walking or falling on its own could
settle at the literal bottom of the WebView, behind that toolbar, reading as having fallen off the
bottom of the screen entirely. On mobile this is a fixed pixel margin held off the viewport's own
height, not a measurement of `app.workspace`'s own bottom edge (desktop's own floor still stops
there, and in practice the two amount to the same place) — a live measurement turned out not to
stay reliably pinned to where the toolbar actually is while a note is mid-scroll, so the fixed
margin is what actually keeps this floor genuinely anchored to the screen regardless of scrolling.

Chasing the mouse is skipped on mobile regardless of its setting: there is no ambient pointer
between touches, so it would only ever be dashing at a stale position.

Right-click's own context menu opens the same way on a long press — held touch and hold-and-drag
are told apart by whether the pointer actually moves before the hold finishes, the same way a real
right-click and a drag never conflict with a mouse.

Shift+triple-click "go to spot" has no touch equivalent (it is a keyboard modifier plus a mouse
gesture) and is dropped on mobile rather than replaced — dragging a mascot by hand already covers
most of the same need.

The character wizard (creating or editing a character: slicing sprite sheets, fitting poses onto a
canvas, removing backgrounds) is desktop-only — real pixel editing needs a mouse and a full-size
screen more than this plugin otherwise asks of a phone. **Settings → Characters** shows a note
instead of the wizard's own controls; packs already built are used and switched between normally
either way, and a pack built or edited on desktop appears here the moment the vault syncs. Vault
search (see AI Assistant above) gets the same treatment for the same reason: indexing a vault with
an in-browser model is a real workload, not something worth asking a phone to do.

Every setting can hold a different value on mobile than on desktop. The first time the vault
opens on a phone, everything starts out identical to desktop — nothing needs configuring twice —
and stays that way until a setting is actually changed while on mobile, at which point just that
one setting remembers its own value there from then on, independent of whatever desktop has (and
desktop keeps changing freely without disturbing it). Turning "Allow dragging" off on a phone,
say, while leaving it on for the mouse on desktop, no longer means picking one value for both.

The one exception is the AI backend list (see AI Assistant above): an API key or local server URL
configured on any device is always the same list everywhere, never a per-device override. Adding
a backend on your phone means it's there on desktop too, and vice versa.

## Commands / UI

Real shimeji-ee actually has *two* separate menus, not one — the desktop tray icon (global,
every character) and each mascot's own right-click menu (`Mascot.java`'s own popup, scoped to
just that mascot's character for "Reduce to One!"/"Follow Mouse!" specifically — genuinely
different real methods, `Manager.remainOne()`/`setBehaviorAll(...)` vs. their `imageSet`-scoped
overloads, not the same feature duplicated). This plugin mirrors that split: commands are the
global/tray equivalent, the per-mascot context menu is character-scoped where the original is.

- Ribbon icon (cat): removes every mascot if any are on screen, otherwise spawns the
  auto-spawn count.
- Commands (global, matching the tray icon): "Spawn mascot" (random character, falling in from
  off-screen at a random x with random initial facing — real `Main.createMascot()`'s own
  `Math.random() < 0.5`, not always facing right), "Remove mascot" (the most recently spawned
  one), "Remove all mascots", "Reduce to one mascot" (keeps the *oldest* one, every character),
  "Make all mascots dash to the mouse (once)" — real "Follow Cursor" exactly, see "Following the
  mouse" below — plus its invented sticky counterparts "Keep all mascots following the mouse" and
  "Stop all mascots following the mouse", "Restore thrown windows" (see "Window mischief" above),
  "Rescan pack folder" (re-reads the pack folder after you add/change files), and "Show the
  next/previous animation" — steps a live mascot through every action its character has, wrapping
  in both directions, so you can page through a pack you are building without opening settings
  (see "Slicing poses out of a sprite sheet" above).
- Right-click a mascot for its own menu (matching the real per-mascot popup, plus "Switch
  character" — a plugin-only convenience with no real analog, since a real mascot's character is
  fixed for its lifetime): add another *of this character* (real per-mascot "Another One!" —
  an otherwise perfectly ordinary fresh spawn, off-screen/random-facing exactly like "Spawn
  mascot" above, just forced to this mascot's character instead of a random one — not an offset
  duplicate standing next to it, which was this menu slot's behavior until checking turned up
  that it didn't actually match anything real), remove it, remove everyone, reduce *this
  character* to one (keeps the *newest* mascot of that character — the real per-character
  overload keeps the opposite end from the global command above, confirmed by reading both, not
  assumed symmetric), dash *this character* to the mouse once / keep it following / stop it
  following, switch its character, jump it straight to a named behavior, restore thrown windows,
  or open plugin settings.
- Settings: pack folder + rescan; per-character on/off toggles under **Characters** (a new
  mascot picks randomly among the ones turned on); the character editor's **Edit...** button
  per character (see above); population controls (spawn/remove-all buttons, max mascots on
  screen, auto-spawn on startup and how many); behavior toggles (allow dragging, allow
  breeding, chase-the-mouse, window mischief, note mischief — see above); size; whether
  panes/status bar count as extra ledges; and a debug overlay that draws the ledges mascots
  currently think they can stand on.

## Development

```
npm install
npm run dev     # esbuild watch, rebuilds main.js on change
npm run build   # typecheck + production bundle
npm test        # vitest — expression engine, XML parsers, ledge geometry, action runner,
                # plus a sanity check that parses the real Shimeji/conf/*.xml directly
```

`main.js` is committed (this plugin lives directly inside a vault's `.obsidian/plugins/`,
not a separate publish repo) — run `npm run build` after changing `src/` and commit the
rebuilt `main.js` alongside your change.
