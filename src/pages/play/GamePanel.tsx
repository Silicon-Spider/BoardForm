// Side panel of a running / finished game: result, resume and error banners, the move list with
// navigation, game actions and one info panel per engine.
import type { ReactNode } from "react";
import { formatDiagnostic } from "@/compiler";
import { Icon, MoveList, ProgressBar, Spinner, startPlyFromFen, type ConfirmFn } from "@/components";
import { Link } from "@/app/router";
import type { EngineCardStatus } from "./EngineCard";
import { EngineCard } from "./EngineCard";
import type { EngineView, GameController, GameState } from "./controller";
import { PlayIcon } from "./icons";
import { MoveDelaySlider } from "./SetupPanel";
import { SIDES, type Side } from "./types";

export interface GamePanelProps {
  state: GameState;
  controller: GameController;
  /** Ply shown on the board; null = following the game. */
  viewPly: number | null;
  onViewPly(ply: number | null): void;
  onNewGame(): void;
  onRematch(): void;
  onAnalyse(): void;
  onBackToSetup(): void;
  onCopyPgn(): void;
  onDownloadPgn(): void;
  onMoveDelay(ms: number): void;
  confirm: ConfirmFn;
}

function engineStatus(ev: EngineView): EngineCardStatus {
  return ev.status === "loading" ? "loading" : ev.status;
}

function ResultBanner({ state, onRematch, onNewGame, onAnalyse, onRetrySave }: { state: GameState; onRematch(): void; onNewGame(): void; onAnalyse(): void; onRetrySave(): void }) {
  const end = state.end!;
  const aborted = end.termination === "aborted";
  const tone = aborted ? "neutral" : end.winner === null ? "draw" : "win";
  const save = state.save;
  return (
    <div className={`play-result play-result--${tone}`} role="status" aria-live="polite">
      <div className="play-result-head">
        <span className="play-result-score">{end.result === "*" ? "—" : end.result === "1/2-1/2" ? "½–½" : end.result.replace("-", "–")}</span>
        <div className="grow">
          <div className="play-result-title">{end.title}</div>
          <div className="play-result-reason">{end.reason}</div>
        </div>
      </div>
      <div className="play-result-save small">
        {save.status === "saving" && <Spinner size={12} label="Saving the game…" />}
        {save.status === "saved" && (
          <span className="text-ok row">
            <Icon name="check" size={14} /> Saved to your games
          </span>
        )}
        {save.status === "skipped" && <span className="muted">No moves were played, so the game was not saved.</span>}
        {save.status === "error" && (
          <span className="text-danger row-wrap">
            <Icon name="alert" size={14} /> Could not save the game: {save.error}
          </span>
        )}
      </div>
      <div className="play-result-actions">
        {!aborted || state.moves.length > state.bookPlies ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onRematch}>
            <PlayIcon name="swap" /> Rematch
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={onNewGame}>
          <Icon name="plus" /> New game
        </button>
        {state.moves.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={onAnalyse}>
            <PlayIcon name="graph" /> Analyse this game
          </button>
        )}
        {save.status === "error" && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetrySave}>
            Retry saving
          </button>
        )}
      </div>
    </div>
  );
}

function LoadingCard({ state, onCancel }: { state: GameState; onCancel(): void }) {
  const rows = SIDES.filter((s) => state.engines[s]).map((s) => ({ side: s, name: state.players[s].name, ev: state.engines[s]! }));
  return (
    <div className="play-loading card" role="status" aria-live="polite">
      <div className="row-between">
        <strong>{state.resuming ? "Resuming the game…" : "Getting the engines ready…"}</strong>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {rows.map((r) => (
        <div key={r.side} className="play-loading-row">
          <span className={`play-player-side play-player-side--${r.side}`} aria-hidden="true" />
          <span className="truncate grow">{r.name}</span>
          <span className="small muted truncate">{r.ev.status === "loading" ? (r.ev.statusText ?? "Waiting…") : "Ready"}</span>
        </div>
      ))}
      <ProgressBar value={null} size="sm" />
      <p className="field-hint">The first build of an engine takes a few seconds; later games start at once.</p>
    </div>
  );
}

function LoadErrorCard({ state, onRetry, onBack, onAbort }: { state: GameState; onRetry(): void; onBack(): void; onAbort(): void }) {
  const err = state.loadError!;
  const errors = (err.diagnostics ?? []).filter((d) => d.severity === "error");
  const first = errors[0];
  const workshop = err.engineId ? `/engines/${err.engineId}${first?.file ? `?file=${encodeURIComponent(first.file)}` : ""}` : null;
  return (
    <div className="callout danger play-loaderror" role="alert">
      <h3>{errors.length ? `${err.name} does not compile` : `${err.name} could not be started`}</h3>
      {errors.length ? (
        <>
          <p className="small">
            Fix {errors.length === 1 ? "this error" : `these ${errors.length} errors`} in the Workshop, then start the game again.
          </p>
          <ul className="play-diagnostics">
            {errors.slice(0, 6).map((d, i) => (
              <li key={i} className="mono">
                {formatDiagnostic(d)}
              </li>
            ))}
            {errors.length > 6 && <li className="muted">…and {errors.length - 6} more</li>}
          </ul>
        </>
      ) : (
        <p className="small">{err.message}</p>
      )}
      <div className="row-wrap">
        {workshop && (
          <Link to={workshop} className="btn btn-sm btn-primary">
            Open in the Workshop
          </Link>
        )}
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          Try again
        </button>
        {state.resuming ? (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onAbort}>
            Abort the game
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onBack}>
            Back to setup
          </button>
        )}
      </div>
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="play-actions" role="toolbar" aria-label="Game actions">
      {children}
    </div>
  );
}

export function GamePanel(props: GamePanelProps) {
  const { state, controller, viewPly, onViewPly, onNewGame, onRematch, onAnalyse, onBackToSetup, onCopyPgn, onDownloadPgn, onMoveDelay, confirm } = props;
  const humans = SIDES.filter((s) => state.players[s].kind === "human");
  const engineSides = SIDES.filter((s) => state.players[s].kind === "engine");
  const playing = state.phase === "playing" || state.phase === "paused";
  const finished = state.phase === "finished";
  const plies = state.san.length;
  const current = viewPly ?? plies;
  const browsing = viewPly !== null && viewPly < plies;

  const resign = async () => {
    const loser: Side = humans.length === 1 ? humans[0] : state.turn;
    const winner = state.players[loser === "w" ? "b" : "w"].name;
    if (await confirm({ title: "Resign this game?", message: `${winner} wins the game.`, confirmLabel: "Resign", danger: true })) controller.resign(loser);
  };
  const abort = async () => {
    const played = state.moves.length > state.bookPlies;
    if (
      await confirm({
        title: engineSides.length === 2 ? "Stop this game?" : "Abort this game?",
        message: played ? "The game ends without a result and is saved as unfinished." : "No moves were played yet, so nothing is saved.",
        confirmLabel: engineSides.length === 2 ? "Stop game" : "Abort game",
        danger: true,
      })
    )
      controller.abort();
  };
  const offerDraw = async () => {
    if (humans.length === 2) {
      if (await confirm({ title: "Agree to a draw?", message: "Both players agree, and the game ends in a draw.", confirmLabel: "Draw" })) controller.offerDraw();
      return;
    }
    controller.offerDraw();
  };

  return (
    <div className="play-game">
      {state.phase === "loading" && <LoadingCard state={state} onCancel={() => controller.abort()} />}
      {state.phase === "failed" && state.loadError && (
        <LoadErrorCard state={state} onRetry={() => controller.resume()} onBack={onBackToSetup} onAbort={() => controller.abort()} />
      )}
      {state.phase === "interrupted" && (
        <div className="callout play-resume" role="status">
          <div className="grow">
            <strong>Game paused while you were away</strong>
            <div className="small muted">
              The clocks stopped when you left. {engineSides.length ? "The engines restart when you resume." : ""}
            </div>
          </div>
          <div className="row-wrap">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => controller.resume()}>
              <Icon name="play" /> Resume game
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={abort}>
              Abort
            </button>
          </div>
        </div>
      )}
      {finished && state.end && <ResultBanner state={state} onRematch={onRematch} onNewGame={onNewGame} onAnalyse={onAnalyse} onRetrySave={() => controller.retrySave()} />}
      {state.notice && (
        <div className={`callout play-notice ${state.notice.kind === "warn" ? "warn" : ""}`} role="status" key={state.notice.id}>
          <span className="grow">{state.notice.text}</span>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Dismiss" onClick={() => controller.dismissNotice()}>
            <Icon name="close" />
          </button>
        </div>
      )}

      <section className="play-moves">
        <div className="play-moves-head">
          <h3 className="section-title">Moves</h3>
          {state.opening && <span className="small muted truncate" title={state.opening}>Book: {state.opening}</span>}
          {!state.opening && state.bookPlies > 0 && <span className="small muted">Random opening · {state.bookPlies} plies</span>}
          <span className="spacer" />
          {browsing && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => onViewPly(null)}>
              Back to game
            </button>
          )}
        </div>
        <MoveList
          san={state.san}
          currentPly={current}
          onSelectPly={(p) => onViewPly(p >= plies ? null : p)}
          startPly={startPlyFromFen(state.startFen)}
          result={finished && state.end && state.end.result !== "*" ? state.end.result : null}
          controls
          emptyText={state.phase === "playing" ? "Waiting for the first move…" : "No moves yet"}
          className="play-movelist"
        />
      </section>

      {playing && (
        <Actions>
          {humans.length > 0 && (
            <>
              <button type="button" className="btn btn-sm" onClick={resign}>
                <PlayIcon name="flag" /> Resign
              </button>
              <button type="button" className="btn btn-sm" onClick={offerDraw} disabled={state.phase !== "playing"}>
                <PlayIcon name="handshake" /> {humans.length === 2 ? "Draw" : "Offer draw"}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => controller.takeback()}
                disabled={state.takebackPlies === 0}
                title={state.takebackPlies ? `Take back ${state.takebackPlies === 1 ? "your last move" : "your last move and the reply"}` : "Nothing to take back yet"}
              >
                <PlayIcon name="undo" /> Takeback
              </button>
            </>
          )}
          {engineSides.length === 2 &&
            (state.phase === "paused" ? (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => controller.resume()}>
                <Icon name="play" /> Resume
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => controller.pause()}>
                <Icon name="pause" /> Pause
              </button>
            ))}
          <button type="button" className="btn btn-sm btn-ghost" onClick={abort}>
            <PlayIcon name="stop" /> {engineSides.length === 2 ? "Stop" : "Abort"}
          </button>
        </Actions>
      )}
      {engineSides.length === 2 && (playing || state.phase === "loading") && <MoveDelaySlider value={state.moveDelayMs} onChange={onMoveDelay} />}

      <div className="play-export">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCopyPgn} disabled={state.moves.length === 0}>
          <Icon name="copy" /> Copy PGN
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDownloadPgn} disabled={state.moves.length === 0}>
          <PlayIcon name="download" /> Download PGN
        </button>
        <span className="spacer" />
        {!finished && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onNewGame}>
            <Icon name="plus" /> New game
          </button>
        )}
      </div>

      {engineSides.map((s) => {
        const ev = state.engines[s];
        const p = state.players[s];
        if (!ev) return null;
        return (
          <EngineCard
            key={s}
            side={s}
            name={p.name}
            color={p.color}
            kind={p.engineKind}
            status={engineStatus(ev)}
            statusText={ev.statusText}
            info={ev.info}
            infoFen={ev.infoFen}
            logs={ev.logs}
          />
        );
      })}
    </div>
  );
}
