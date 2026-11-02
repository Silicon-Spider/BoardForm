# Search limits and time controls

How long an engine thinks about a move is up to you. Every engine in a game gets its own **search limits** — depth, nodes and time per move — and optionally a **clock**. The same limits editor appears on the Play page, in the Arena and in the NNUE Lab.

## Whichever comes first

All limits can be combined, and the engine stops at **whichever limit it reaches first**. Depth 12 with a 3+2 clock means "search up to 12 plies deep, but never spend more time than the clock allows"; in a simple position the engine reaches depth 12 quickly and moves at once, in a complicated one the clock decides.

| Limit | In the editor | What it means |
| --- | --- | --- |
| Depth | **Depth** (plies) | Don't start a search iteration deeper than this many plies. |
| Nodes | **Max positions searched (nodes)** | The maximum number of positions the engine may search for this move. |
| Time per move | **Time per move** (seconds) | Spend at most this long on this move. |
| Clock | **Time control** (**Clock** in compact editors) | A game clock: base time, increment, moves per control. The engine manages its own time. |

Turn a limit on with its checkbox (in the compact version of the editor, type a value; an empty field means no limit). If you set no clock and no limit at all, the editor warns you — an engine without any limit would think forever — and in a game Chess Builder then gives the engine one second per move.

## Depth

A **ply** is one move by one side, so depth 6 means three moves for each side. Engines search iteratively — depth 1, then 2, 3 … — and the depth limit stops them from starting an iteration deeper than the limit. The search still looks further along forcing lines: captures in the quiescence search and checks through check extensions.

Each extra ply costs a few times more work than the last, and how much varies enormously between positions: depth 10 can take a few milliseconds in an endgame and several seconds in a sharp middlegame. That makes depth a poor way to control time, and an unfair way to compare engines that prune differently — an engine that prunes aggressively reaches depth 10 sooner but has looked at less.

## Nodes

A **node** is one position the search visits. The node limit is the maximum number of positions the engine may search before it must decide, so it measures *work*, not time.

- The template engine counts every position it visits, in the main search and in the quiescence search, and checks the limit at every node, so it stops almost exactly at the limit. Engines from scratch may check less often and stop roughly there.
- Results with a node limit don't depend on the speed of your computer or on what else is running: started from the same state, an engine searches exactly the same tree every time.
- A node limit ignores speed. An engine whose evaluation is twice as slow is not punished at all, although it would be in a timed game.

Small node limits make good sparring partners: an engine limited to a few thousand nodes per move plays quickly and is much easier to beat.

## Time per move

**Time per move** gives the engine up to that many seconds for every move. The template engine uses all of it (minus 5 ms): unused time can't be saved for later moves.

## Clocks

A **time control** gives each player a clock:

- **Base time** — the time on the clock at the start, in minutes.
- **Increment** — seconds added after each move.
- **Moves per control** (optional) — the number of moves in each time period, as in classical chess ("40 moves in 90 minutes"): each time a player completes a period, the base time is added to their clock again. Leave it empty for one period covering the whole game.

Time controls are written *base + increment*: **3+2** is 3 minutes plus 2 seconds per move, and *40/90+30* is 40 moves in 90 minutes plus 30 seconds per move. The presets are 1+0 (bullet), 3+2 and 5+0 (blitz), 10+5 and 15+10 (rapid) and 30+0 (classical); **Custom** sets your own, and **No clock** plays with search limits only.

With a clock, the engine is told both players' remaining time, the increments and how many moves are left until the next time control, and it decides itself how much to spend. If its clock runs out, it loses on time — or draws, if the opponent has nothing left to checkmate with.

## How the template engine spends its time

Engines built on the template — Blocks, Eval code and NNUE engines, and Full code engines unless you changed `search.ts` — budget their time like this:

1. Keep 30 ms in reserve for talking to the app: `available = remaining − 30`.
2. Plan `available / moves-to-go + ¾ × increment`, where *moves-to-go* is the number of moves until the next time control (at most 40), or 25 when there is none. Never plan more than a quarter of `available`.
3. Don't start a new iteration once the plan (the *soft limit*) has been used; abort the search outright at three times the plan or 40 % of `available` (the *hard limit*), whichever is smaller.
4. Stop early when a forced mate has been found that a deeper search can't improve.

The node limit is checked at every position searched, the clock and the app's stop request every 1024. Your own [Full code](#/help/full-engine?section=time-management) engine can do it differently.

## What the app enforces

The app doesn't rely on engines to stop by themselves:

- With a **time per move**, it intervenes after the time plus 100 ms plus 10 %. In the Arena, that counts as a loss on time; on the Play page, without a clock, the late move is still played and the engine's console notes the overrun.
- With a **clock**, it intervenes when the engine's remaining time (plus 100 ms) is used up — the engine has lost on time.
- To intervene, it first asks the engine to stop, and terminates it one second later if it still doesn't answer. The engine is then restarted for the next move.

In the Arena, the time an engine is charged is measured inside its own worker, so a busy page never costs it time; the Play page does the same whenever a slow page would otherwise make an engine lose on time.

## Choosing fair limits for matches

What you want to measure decides the limits:

- **Use the same limits for both engines,** unless you are deliberately testing a handicap.
- **Testing an evaluation change on the same search?** Use **fixed nodes**, for example 10 000 to 50 000 per move. Games are fast, results are reproducible, and other work on the computer doesn't disturb them.
- **Comparing different engines, or a change that affects speed?** Use a **clock**. Speed is part of strength, and only a clock counts it. A short control with an increment — for example Custom with a base of 1 minute and 0.5 seconds increment — gives many games quickly without running into time trouble.
- **Avoid fixed depth** for comparisons: it is unfair between engines that prune differently, and the time per move varies wildly.
- **Very short time controls** exaggerate the cost of overhead (the template keeps 30 ms per move in reserve); below a few hundred milliseconds per move, results get noisy.
- **Run at most one game per core** in timed matches, and keep other heavy work (such as a training run) off the computer while they run. Node-limited matches don't mind.
- **Give both engines the same hash size.** A bigger transposition table helps in long games.

## Quick recipes

| Goal | Limits |
| --- | --- |
| A quick, beatable opponent | Nodes 1 000–5 000, no clock |
| A serious game against your engine | A clock such as 10+5 for both players |
| Fast evaluation testing in the Arena | Nodes 20 000 per move, no clock |
| Comparing two different engines | Custom clock: 1 minute + 0.5 s |
| Self-play data for the NNUE Lab | Nodes around 5 000 per move |
