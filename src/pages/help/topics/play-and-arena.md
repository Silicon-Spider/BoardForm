# Play and the Arena

Building an engine is half the fun; the other half is watching it play. The [Play](#/play) page is for single games — against you, against another engine, or analysis — and the [Arena](#/arena) runs whole matches and tournaments to measure strength.

## Playing against an engine

The [Play](#/play) page has two modes, **Play** and **Analysis**. In Play mode, the **New game** panel sets up a game:

- **Quick start** offers ready-made games: *You vs engine* (as White or as Black, the engine thinking one second per move), *Blitz 5+3* and *Engine vs engine*.
- **Players:** choose **Human** or one of your engines for White and for Black (the swap button between them exchanges the colours). Each engine gets its own [limits](#clocks-and-limits) and hash table size; a human player gets a clock or none.
- **Start position:** **Standard**, a named **Opening**, **Random** moves for variety, or a **Custom** FEN.

Then press **Start game** and play:

- **Moving:** drag a piece, or click it and then click the target square. Legal-move dots mark where the selected piece can go (switch them off in [Settings](#/settings?section=appearance)). When a pawn promotes, pick the new piece.
- **Drawing on the board:** right-drag from one square to another to draw an arrow, or right-click a square to circle it — handy for planning. A left click clears the drawings.
- **Following the engine:** its card shows the score, depth, nodes, speed and time of its search, its principal variation and a **Console** with anything it logs. The evaluation bar beside the board can be shown or hidden, and <kbd>F</kbd> flips the board.
- **Taking a move back:** **Takeback** undoes your last move (and the engine's reply).
- **Ending a game early:** **Resign**, **Offer draw** or **Abort** (an aborted game has no result). An engine accepts a draw offer only after 20 moves each and only when its evaluation is within ±0.30 pawns; between two human players **Draw** ends the game at once.

A game that is still running when you close the tab is paused and waits for you when you come back. The Workshop's **Play** button — or a link like `#/play?engine=<engine id>` — starts a game against that engine with you as White.

## Engine against engine

Choose an engine for both colours and watch them play each other, each with its own limits. A **Move delay** pauses between the moves so you can follow the game, **Pause** and **Resume** halt and continue it, and **Stop** ends it without a result. This is the quickest way to see how a change plays; to measure it, use the [Arena](#matches-and-tournaments).

## Analysis

In **Analysis** mode, choose an engine to analyse with. It searches the position on the board continuously and shows its score and best line while you play moves or step through a game with <kbd>←</kbd> / <kbd>→</kbd>; whenever the position changes, it starts again on the new one. Scores can be shown from White's point of view or from the side to move's. The **Position** tools set up a position piece by piece (**Set up…**), paste one (**Load FEN…**), load a game (**Import PGN…**), or turn the position on the board into a game against an engine (**Play from here**).

Analysis uses an *infinite* search that runs until it is stopped. Chess Builder normally stops a search instantly through shared memory; when the browser doesn't allow that, it restarts the engine instead, which works just as well but takes a moment (**Instant engine stop** in [Settings](#/settings?section=engines) shows which one you have).

## Clocks and limits

Each engine gets its own limits, set with the same editor everywhere in the app:

- a **clock** — one of the presets (1+0, 3+2, 5+0, 10+5, 15+10, 30+0), **Custom** (base time, increment and optionally moves per control) or **No clock**;
- optional **search limits** per move: **Depth**, **Max positions searched (nodes)** and **Time per move**.

The engine stops at whichever limit it reaches first. [Search limits and time controls](#/help/limits) explains each one and how to pick fair settings.

## How games end

The rules end a game by **checkmate**, **stalemate**, **threefold repetition**, the **fifty-move rule** or **insufficient material**. A game can also end by **timeout** — a clock ran out, which is a draw instead of a loss when the opponent has no mating material left — by **resignation**, by an agreed **draw**, by [adjudication](#adjudication) in the Arena, or because an engine misbehaved. An engine **loses the game** when it

- plays an **illegal move**,
- **crashes**, or
- answers "no move" although it has legal moves — this is how an unfinished [scratch](#/help/scratch) engine behaves.

## Saved games

Finished games are saved automatically, with their moves, the engines' evaluations and the time spent on every move. The **Saved games** tab lists them — **All**, **My games** or **Matches** (Arena games) — with a search box once the list gets long. Open a game to replay it on the analysis board, with a graph of the evaluations; **Download PGN** to use it in other chess programs; or **Import PGN** to study a game from elsewhere.

## Matches and tournaments

The [Arena](#/arena) plays many games between engines and keeps score. **New match** (or the Workshop's **Match** button) opens the match form:

- **Engines:** two or more, each with its own limits and hash table — or tick **Same settings for every engine** to give them all the same ones. **Add engine** adds another participant.
- **Format:** **Round robin** (every engine plays every other) or **Gauntlet** (the first engine plays each of the others — ideal for testing one new version against several opponents).
- **Games per pairing:** colours alternate from game to game, so use an even number — then both engines play each opening with both colours.
- **Openings:** the **Opening book** of named openings, **Random moves** (a number of random half-moves; the same **seed** gives the same openings), or **Start position** (every game from the start — deterministic engines may then play the same game over and over).
- **Adjudication:** see [below](#adjudication).
- **Games at once:** how many games run in parallel; each game runs two engines. The maximum is your **Background workers** setting in [Settings](#/settings?section=engines).
- **Save every game**, needed to replay the games and export them as PGN.

With no match yet, **Quick match: Classic vs Blocky** plays four games at 10 seconds + 0.1 seconds per side, straight away.

While a match runs you can watch the **live games** (click a board to follow it), the **standings**, a **crosstable** of the points each engine scored against each other one, and the finished **games**, which you can replay. Matches keep running while you use other pages. **Pause** a match and **Resume** it later; games that were interrupted are replayed from the beginning. A match that was still running when its tab closed shows as interrupted, ready to be resumed. **Abort** ends a match for good with its current standings.

## Elo and LOS

The standings list, for every engine, its games, wins (W), draws (D), losses (L), points and score, and two numbers that answer "is it really stronger?": **Elo** and **LOS**. In a match between two engines they compare the two; with more engines, each engine is compared with the average of its opponents.

- **Score** = (wins + draws / 2) / games, from that engine's point of view.
- **Elo difference** = −400 × log₁₀(1 / score − 1). A 55 % score is about +35 Elo, 60 % about +70, 64 % +100, 75 % about +191, and 50 % is 0.
- **± error margin:** the 95 % confidence interval, worked out from the spread of wins, draws and losses. The true difference lies inside *Elo ± margin* with 95 % confidence. The margin shrinks with the square root of the number of games.
- **LOS** (likelihood of superiority) is the probability that the engine really is the stronger one. It uses only wins and losses (draws carry no information about who is better): LOS = ½ × (1 + erf((wins − losses) / √(2 × (wins + losses)))).

Some examples:

| Games | Wins / draws / losses | Score | Elo | LOS |
| --- | --- | --- | --- | --- |
| 20 | 12 / 6 / 2 | 75 % | +191 ± 152 | 99.6 % |
| 100 | 40 / 30 / 30 | 55 % | +35 ± 58 | 88 % |
| 1000 | 400 / 300 / 300 | 55 % | +35 ± 18 | > 99.9 % |

The same 55 % score means little after 100 games and a lot after 1000. A common rule: accept a change when the LOS is above 95 % and the error margin is smaller than the improvement you measured.

## Adjudication

Hopeless and dead-drawn games can take a long time to finish. In the Arena, adjudication ends them early, using the engines' own scores:

- **Resign when both engines see one side clearly winning:** when both engines agree that the same side is **ahead by at least** a number of centipawns (900 by default) **for** a number of moves each (4), that side wins.
- **Draw when both engines score the position as level:** when both engines' scores stay **within ±** a few centipawns (10) **for** a number of moves each (8), counted only **after ply** 80, the game is drawn.
- **Draw games that get too long:** a game that reaches the maximum number of plies (400) is a draw.

A move for which an engine reported no score breaks the streak. Adjudication saves a lot of time, but it trusts the engines' judgement — a fortress or a long endgame win can be misjudged — so keep the thresholds generous.

## Tips for meaningful results

- **Same limits for both sides,** unless you are testing a handicap on purpose.
- **Play many games.** Use openings so the games are different, and an even number of games per pairing.
- **Keep the computer quiet** during timed matches: other heavy work — a training run, for example — slows the engines down. Fixed-node limits are not affected by load.
- **Don't run more games at once than your computer has cores** in timed matches.
- **Compare against a baseline:** duplicate an engine before changing it and play the two versions against each other.
