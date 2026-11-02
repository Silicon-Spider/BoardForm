// @/components — shared UI kit. (The CodeMirror editor lives in src/components/code/.)
export { Chessboard } from "./Chessboard";
export type { ChessboardProps, ChessboardArrow } from "./Chessboard";
export { BoardEditor } from "./BoardEditor";
export type { BoardEditorProps } from "./BoardEditor";
export { MiniBoard } from "./MiniBoard";
export type { MiniBoardProps } from "./MiniBoard";
export { pieceUrl } from "./boardCore";
export type { Orientation } from "./boardCore";

export { MoveList, startPlyFromFen } from "./MoveList";
export type { MoveListProps } from "./MoveList";
export { Clock } from "./Clock";
export type { ClockProps } from "./Clock";
export { EvalBar, evalToWhiteShare } from "./EvalBar";
export type { EvalBarProps } from "./EvalBar";
export { LineChart, CHART_COLORS, niceTicks } from "./LineChart";
export type { LineChartProps, ChartSeries, ChartPoint } from "./LineChart";

export { Modal } from "./Modal";
export type { ModalProps } from "./Modal";
export { ConfirmDialog, useConfirm, confirmDialog } from "./ConfirmDialog";
export type { ConfirmDialogProps, ConfirmOptions, ConfirmFn } from "./ConfirmDialog";
export { Tabs } from "./Tabs";
export type { TabsProps, TabItem } from "./Tabs";
export { ProgressBar } from "./ProgressBar";
export type { ProgressBarProps } from "./ProgressBar";
export { Tooltip } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";
export { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarSpacer } from "./Toolbar";
export type { ToolbarProps } from "./Toolbar";

export { LimitsEditor, TIME_CONTROL_PRESETS, formatTimeControl, describeLimits, timeControlPresetId } from "./LimitsEditor";
export type { LimitsEditorProps, LimitsValue, TimeControlPreset } from "./LimitsEditor";
export { EnginePicker } from "./EnginePicker";
export type { EnginePickerProps, EnginePickerOption } from "./EnginePicker";
export { KindBadge, KIND_LABELS, KIND_DESCRIPTIONS, kindColor } from "./KindBadge";
export type { KindBadgeProps } from "./KindBadge";
export { Spinner } from "./Spinner";
export type { SpinnerProps } from "./Spinner";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { Icon } from "./icons";
export type { IconName, IconProps } from "./icons";
