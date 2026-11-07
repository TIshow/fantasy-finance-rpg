// platform（store・ingest・runner・llm）と web が、同じ型だけに依存するための契約。型だけで、実装は置かない。
export type { Clock } from "./clock";
export type { CommitResult, DraftInput, EventReader, EventStore, OrderlessEventStore, SheetInput } from "./event-store";
export type { CloseObservation, MarketDataPort, MarketView, OpenObservation, PriceObservation } from "./market-data";
export type {
  LlmBatchClosed,
  LlmBatchPort,
  LlmBatchRequest,
  LlmBatchTicket,
  LlmCollectResult,
  LlmErrorCode,
  LlmMessage,
  LlmModel,
  LlmPolicy,
  LlmPort,
  LlmPrompt,
  LlmPurpose,
  LlmRequest,
  LlmResult,
  LlmSubmitResult,
  LlmUsage,
} from "./llm";
