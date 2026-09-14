import { useCallback, useEffect, useRef, useState } from 'react';

import { createSourceSendIntent, loadSourceProfile, sourceSendIntentSchema, type SourceSendInput } from '../lib/memory-source-client';
import type { SourceProfile } from '../lib/memory-source-contract';
import { chatSanitizer } from '../lib/sanitize';
import { useConnectivityStore } from '../stores/connectivity-store';

/** Observation before explicit action, not permission for subsequent dispatch. */
export function useSessionSourceInputs(owner: string, session: string, thread: string) {
  const scope = JSON.stringify([owner, session, thread]);
  const currentScope = useRef(scope);
  const generation = useRef(0);
  if (currentScope.current !== scope) generation.current += 1;
  const capturedGeneration = generation.current;
  currentScope.current = scope;
  const [observation, setObservation] = useState<{ scope: string; profile: SourceProfile } | null>(null);
  const observationRef = useRef(observation);
  observationRef.current = observation;
  const active = useRef(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    active.current = true;
    const abort = new AbortController();
    setObservation(null);
    if (owner && session && thread) {
      void loadSourceProfile(owner, session, thread, abort.signal).then(profile => {
        if (!abort.signal.aborted && currentScope.current === scope) setObservation({ scope, profile });
      }).catch(() => { /* Unknown is unavailable, never an inferred legacy owner. */ });
    }
    return () => { active.current = false; abort.abort(); };
  }, [owner, session, thread, scope, revision]);

  const currentProfile = useCallback(() => {
    if (!active.current || generation.current !== capturedGeneration || currentScope.current !== scope || observationRef.current !== observation || observation?.scope !== scope) throw new Error('memory_source_profile_unavailable');
    return observation.profile;
  }, [scope, observation, capturedGeneration]);

  const captureSourceInput = useCallback((text: string): SourceSendInput => {
    const content = chatSanitizer.sanitize(text);
    const profile = currentProfile();
    const intent = createSourceSendIntent(profile, content);
    if (!intent) return { text: content };
    // Persist BEFORE any asynchronous send or offline queue operation. This is
    // existing transport retry state, never a second memory authority.
    useConnectivityStore.getState().rememberSourceIntent(intent);
    return { text: content, sourceIntent: intent };
  }, [currentProfile, owner, session, thread]);

  const retrySourceInput = useCallback((text: string, messageId: string | null): SourceSendInput => {
    if (currentProfile().authority === 'legacy') {
      const state = useConnectivityStore.getState();
      // A profile observation cannot turn an original governed action into a
      // different legacy send. Local references only deny this downgrade;
      // they never authorize a source or replace canonical owner authority.
      const priorIntent = state.messageQueue.some(item => {
        if (!item.sourceIntent) return false;
        const intent = sourceSendIntentSchema.parse(item.sourceIntent);
        return intent.owner_id === owner && intent.session_id === session && intent.action.thread_id === thread;
      });
      if (priorIntent) throw new Error('memory_source_retry_unavailable');
      return { text };
    }
    if (!messageId) throw new Error('memory_source_retry_unavailable');
    const intent = useConnectivityStore.getState().findSourceIntent(owner, session, thread, messageId, text);
    return { text, sourceIntent: intent };
  }, [currentProfile, owner, session, thread]);

  const validateSourceInput = useCallback((input: SourceSendInput) => {
    if (!active.current || currentScope.current !== scope || generation.current !== capturedGeneration) throw new Error('memory_source_profile_unavailable');
    if (input.sourceIntent) {
      const intent = sourceSendIntentSchema.parse(input.sourceIntent);
      if (intent.owner_id !== owner || intent.session_id !== session || intent.action.thread_id !== thread || intent.action.content !== input.text) {
        throw new Error('memory_source_action_scope_invalid');
      }
    } else if (currentProfile().authority !== 'legacy') throw new Error('memory_source_action_required');
  }, [scope, owner, session, thread, currentProfile, capturedGeneration]);

  // A deliberate observation refresh only changes future explicit actions.
  // Never call it inside retry or rewrite any stored original source intent.
  const refreshSourceProfile = useCallback(() => { observationRef.current = null; setObservation(null); setRevision(value => value + 1); }, []);
  return { captureSourceInput, retrySourceInput, validateSourceInput, refreshSourceProfile,
    sourceProfile: observation?.scope === scope ? observation.profile : null,
    sourceProfileReady: observation?.scope === scope };
}
