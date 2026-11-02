// @/nnue — NNUE toolkit: CBNN network files, reference inference, training data packing,
// network init / widening, the trainer core and the trainer worker client.
// See docs/NNUE_FORMAT.md (normative) and docs/ARCHITECTURE.md §5.
//
// Workers (e.g. self-play) should import the submodules they need directly
// (`@/nnue/pack`, `@/nnue/format`, ...) so their bundles don't pull in the trainer client.

export {
  INPUTS,
  QA,
  QB,
  SCALE,
  WEIGHT_CLIP,
  HEADER_SIZE,
  CBNN_MAGIC,
  CBNN_VERSION,
  MIN_HIDDEN,
  MAX_HIDDEN,
  HIDDEN_SIZE_PRESETS,
  DEFAULT_HIDDEN,
  DEFAULT_ACTIVATION,
  ACTIVATION_NAMES,
  NetworkFormatError,
  isValidHidden,
  assertValidHidden,
  networkFileSize,
  networkFileOffsets,
  clipWeight,
  validateFloatNetwork,
  quantizeWeights,
  serializeNetwork,
  quantizeNetwork,
  dequantizeNetwork,
  readNetworkHeader,
  parseNetworkFile,
  inspectNetworkFile,
  type QuantizedNetwork,
  type NetworkFileHeader,
} from "./format";

export { FenError, PIECE_CHARS, parseFenBoard, boardToFen, squareName, squareFromName, type BoardPiece, type FenBoard } from "./fen";

export {
  MAX_FEATURES,
  featureIndex,
  createFeatureSet,
  featuresFromPieces,
  extractFeatures,
  extractPackedFeatures,
  type FeatureSet,
} from "./features";

export {
  evaluateFloat,
  evaluateFloatFeatures,
  forwardFloatFeatures,
  evaluateQuantized,
  evaluateQuantizedFeatures,
} from "./reference";

export {
  PACKED_SIZE,
  MAX_PACKED_PIECES,
  PACKED_SCORE_LIMIT,
  POSITIONS_PER_CHUNK,
  packPosition,
  packBoard,
  setPackedResult,
  unpackPosition,
  packedToFen,
  packedScore,
  validatePacked,
  decodePackedFeatures,
  type PackedResult,
  type UnpackedPosition,
} from "./pack";

export {
  W1_INIT_RANGE,
  parameterCount,
  emptyNetwork,
  createNetwork,
  widenNetwork,
  cloneNetwork,
  zerosLike,
  createOptimizerState,
  cloneOptimizerState,
  validateOptimizerState,
} from "./init";

export {
  ADAM_BETA1,
  ADAM_BETA2,
  ADAM_EPS,
  DEFAULT_HYPER_PARAMS,
  DEFAULT_LR_GAMMA,
  DEFAULT_COSINE_FLOOR_RATIO,
  Trainer,
  sigmoid,
  trainingTarget,
  learningRateAt,
  defaultLrStepEpochs,
  validateHyperParams,
  type TrainerHyperParams,
  type TrainerConfig,
  type LrScheduleParams,
} from "./trainer";

export {
  DEFAULT_MAX_DATASET_BYTES,
  buildTrainingSet,
  splitTrainValidation,
  epochPermutation,
  type TrainingSet,
} from "./dataset";

export { TrainingSession, TrainingDivergedError, type SessionCallbacks, type TrainingSessionOptions } from "./session";

export type {
  TrainJob,
  TrainProgress,
  TrainCheckpoint,
  TrainCursor,
  TrainEpochSummary,
  TrainHandlers,
  TrainerRequest,
  TrainerEvent,
} from "./protocol";

export { TrainerClient, TrainerTerminatedError, createTrainerWorker, type TrainerWorkerLike } from "./trainerClient";

// Multi-threaded training support checks (the threads themselves live inside the trainer worker).
export { threadSupport, clampThreads, maxThreadsForHidden } from "./parallel";

export { makeMaterialDataset, materialBalance, randomPosition } from "./synthetic";
