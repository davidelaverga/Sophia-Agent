/**
 * Reusable UI components
 * 
 * These components are framework-agnostic and can be used
 * across V1 (legacy) and V2 implementations.
 */

export { Waveform, type WaveformState } from "./Waveform";

// Error States
export { 
  ErrorCard, 
  StreamError, 
  detectErrorKind,
  type ErrorKind,
} from './ErrorStates';

// Error Modal
export {
  ErrorModal,
  SessionExpiredModal,
  NetworkErrorModal,
  MultiTabModal,
  type ErrorType,
  type ErrorAction,
  type ErrorModalProps,
} from './ErrorModal';

// Skeletons
export {
  Skeleton,
  MessageSkeleton,
  CardSkeleton,
  RitualCardSkeleton,
  StatCardSkeleton,
  TextSkeleton,
  PageSkeleton,
  ChatLoadingSkeleton,
} from './Skeletons';
