export type SessionDocumentLocation = Pick<Location, 'assign'>;

/**
 * Move from the dashboard into the session as a new document.
 *
 * The session route owns authentication, consent, persisted-session recovery,
 * and microphone initialization. A full document navigation guarantees that
 * those boundaries start together instead of leaving a partially committed
 * App Router transition with only the destination URL applied.
 */
export function navigateToSessionDocument(location: SessionDocumentLocation): void {
  location.assign('/session');
}
