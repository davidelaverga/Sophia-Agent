'use client';

import { useEffect, useRef, useState } from 'react';

import { recordSophiaCaptureEvent } from '../lib/session-capture';

type VoiceLabControlAction = 'session-start' | 'voice-start';

type VoiceLabControlReceipt = {
  ok: true;
  schema: 'sophia_voice_lab_control_adapter_v1';
  action: VoiceLabControlAction;
  test_run_id: string;
  scenario_id: string | null;
  scenario_version: string | null;
  cleanup_obligation_id: string;
  expected_deployment: {
    frontend: string;
    backend: string;
    voice: string;
  };
  control_epoch_sha256: string;
  expires_at: number;
  ordinary_user_access: false;
};

type ControlRequestEntry = {
  promise: Promise<VoiceLabControlReceipt | null>;
  receipt: VoiceLabControlReceipt | null;
};

const controlRequests = new Map<VoiceLabControlAction, ControlRequestEntry>();
const claimedControlEpochs = new Set<string>();

function isControlReceipt(value: unknown, action: VoiceLabControlAction): value is VoiceLabControlReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Partial<VoiceLabControlReceipt>;
  const deployment = receipt.expected_deployment;
  return receipt.ok === true
    && receipt.schema === 'sophia_voice_lab_control_adapter_v1'
    && receipt.action === action
    && typeof receipt.test_run_id === 'string'
    && typeof receipt.cleanup_obligation_id === 'string'
    && typeof receipt.control_epoch_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(receipt.control_epoch_sha256)
    && Number.isInteger(receipt.expires_at)
    && Number(receipt.expires_at) > Math.floor(Date.now() / 1000)
    && receipt.ordinary_user_access === false
    && Boolean(deployment)
    && typeof deployment?.frontend === 'string'
    && typeof deployment?.backend === 'string'
    && typeof deployment?.voice === 'string';
}

function requestControlReceipt(action: VoiceLabControlAction): Promise<VoiceLabControlReceipt | null> {
  const existing = controlRequests.get(action);
  if (existing?.receipt && existing.receipt.expires_at > Math.floor(Date.now() / 1000)) {
    return Promise.resolve(existing.receipt);
  }
  if (existing) return existing.promise;

  const entry: ControlRequestEntry = { promise: Promise.resolve(null), receipt: null };
  entry.promise = (async () => {
    const response = await fetch(`/api/voice-lab/control/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) return null;
    const receipt: unknown = await response.json();
    if (!isControlReceipt(receipt, action)) return null;
    entry.receipt = receipt;
    return receipt;
  })().catch(() => null).then((receipt) => {
    if (!receipt) controlRequests.delete(action);
    return receipt;
  });
  controlRequests.set(action, entry);
  return entry.promise;
}

function claimControlReceipt(receipt: VoiceLabControlReceipt): boolean {
  const claim = `${receipt.test_run_id}:${receipt.action}:${receipt.control_epoch_sha256}`;
  if (claimedControlEpochs.has(claim)) return false;
  claimedControlEpochs.add(claim);
  controlRequests.delete(receipt.action);
  return true;
}

export function resetVoiceLabControlAdapterForTests(): void {
  controlRequests.clear();
  claimedControlEpochs.clear();
}

export function useVoiceLabControlAdapter(
  action: VoiceLabControlAction,
  invokeExistingAction: () => void | Promise<void>,
  enabled = true,
): void {
  const invokedRef = useRef(false);
  const invokeExistingActionRef = useRef(invokeExistingAction);
  const readinessLatchedRef = useRef(enabled);
  const [authorizedReceipt, setAuthorizedReceipt] = useState<VoiceLabControlReceipt | null>(null);

  if (enabled) {
    readinessLatchedRef.current = true;
  }

  useEffect(() => {
    invokeExistingActionRef.current = invokeExistingAction;
  }, [invokeExistingAction]);

  useEffect(() => {
    let active = true;

    void (async () => {
      const receipt = await requestControlReceipt(action);
      if (!receipt || !active) return;
      recordSophiaCaptureEvent({
        category: 'voice-lab-control',
        name: 'authorized-action',
        payload: receipt,
      });
      setAuthorizedReceipt(receipt);
    })().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [action]);

  useEffect(() => {
    if (!authorizedReceipt || !readinessLatchedRef.current || invokedRef.current) return;
    if (!claimControlReceipt(authorizedReceipt)) return;
    invokedRef.current = true;

    void (async () => {
      recordSophiaCaptureEvent({
        category: 'voice-lab-control',
        name: 'authorized-action-invoking',
        payload: { action },
      });
      try {
        await invokeExistingActionRef.current();
        recordSophiaCaptureEvent({
          category: 'voice-lab-control',
          name: 'authorized-action-completed',
          payload: { action },
        });
      } catch (error) {
        recordSophiaCaptureEvent({
          category: 'voice-lab-control',
          name: 'authorized-action-failed',
          payload: {
            action,
            error_class: error instanceof Error ? error.name : 'Error',
          },
        });
        throw error;
      }
    })().catch(() => undefined);
  }, [action, authorizedReceipt, enabled]);
}
